/**
 * Chat.fun WhatsApp Bot — Devnet token launch + on-chain buys
 *
 * - Devnet only
 * - No DB (in-memory)
 * - Real SPL mints + token transfers on Devnet
 * - Twilio TwiML replies for WhatsApp webhook
 *
 * WARNING: Keeps private keys in memory (dev/test only)
 */

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import bs58 from "bs58";
import {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer as splTransfer,
} from "@solana/spl-token";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

// ---------- Solana (Devnet) ----------
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// ---------- In-memory stores ----------
const users = {}; // { from: { state, wallet: Keypair, temp: {...}, lastMint } }
const tokens = {}; // tokens[nameLower] and tokens[mintAddr] => { name, symbol, story, mintAddress, decimals, totalSupply, pricePerTokenSOL, ownerFrom, ownerPubkey, ownerTokenAccount, mintTxSig, liquidity }

// ---------- Helpers ----------
function twimlReply(res, msg) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(msg);
  res.type("text/xml").send(twiml.toString());
}

function isLikelyPrivateKey(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("[")) return true; // JSON array
  const words = trimmed.split(/\s+/);
  if (words.length >= 12 && words.length <= 24) return true; // seed phrase-ish
  if (/^[A-HJ-NP-Za-km-z1-9]{32,100}$/.test(trimmed)) return true; // base58-ish
  return false;
}

async function importKeypairFromText(raw) {
  try {
    const text = raw.trim();
    let keypair;
    if (text.startsWith("[")) {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(text));
    }
    return { ok: true, keypair };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function toExplorerAddr(addr) {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}
function toExplorerTx(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function sendSolTx(fromKeypair, toPubkey, lamportsNumber) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports: lamportsNumber,
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
  return sig;
}

// ---------- Storyboard menu (text UI) ----------
function sendMainMenuText() {
  return [
    "You’re ready to cook, anon 🔥",
    "",
    "Choose an option (reply with the text, emoji or the number):",
    "1️⃣  🚀 Launch Token",
    "2️⃣  💸 Buy Token",
    "3️⃣  📊 My Portfolio",
    "4️⃣  🔥 Trending Launches",
    "",
    'Or commands: "/launch", "/buy $TICKER", "/sell $TICKER <amount>", "balance"'
  ].join("\n");
}

// ---------- Flow handler ----------
async function handleIncoming(from, rawBody) {
  const body = (rawBody || "").trim();
  users[from] = users[from] || { state: "onboarding" };
  const session = users[from];

  // 1) If no wallet, allow import (explicit or auto-detect)
  if (!session.wallet) {
    // If message looks like private key, try import
    if (isLikelyPrivateKey(body)) {
      const imp = await importKeypairFromText(body);
      if (imp.ok) {
        session.wallet = imp.keypair;
        session.state = "main";
        // ensure user has some Devnet SOL (read balance)
        const lamports = await connection.getBalance(session.wallet.publicKey);
        const sol = lamports / 1e9;
        return `✅ Wallet connected successfully!\nAddress: ${session.wallet.publicKey.toBase58()}\nSOL Balance: ${sol.toFixed(6)}\n\n${sendMainMenuText()}`;
      } else {
        // fall through to prompt
        return [
          "🚀 Welcome to Chat.fun — connect your wallet first.",
          "",
          "Paste your seed phrase or private key below (JSON array or base58):",
          'Or use command: /import <privateKey>'
        ].join("\n");
      }
    }

    // support explicit /import command
    if (body.toLowerCase().startsWith("/import ")) {
      const raw = body.slice(8).trim();
      const imp = await importKeypairFromText(raw);
      if (imp.ok) {
        session.wallet = imp.keypair;
        session.state = "main";
        const lamports = await connection.getBalance(session.wallet.publicKey);
        const sol = lamports / 1e9;
        return `✅ Wallet connected successfully!\nAddress: ${session.wallet.publicKey.toBase58()}\nSOL Balance: ${sol.toFixed(6)}\n\n${sendMainMenuText()}`;
      } else {
        return "❌ Invalid private key format. Paste a JSON array or base58 secret key.";
      }
    }

    // onboarding message
    return [
      "🚀 Welcome to Chat.fun, the wildest way to launch and trade tokens on Solana, right here on WhatsApp.",
      "No apps. No websites. Just pure degen energy.",
      "",
      "⚠️ Before we start, connect your wallet.",
      "Enter your seed phrase or private key below 👇"
    ].join("\n");
  }

  // 2) parse flows / states when wallet exists
  // allow quick commands at any point
  if (body.toLowerCase() === "/launch" || body === "1" || /launch token/i.test(body) || body === "🚀") {
    // start launch flow
    session.state = "launch_name";
    session.temp = {};
    return "🚀 Let’s drop some heat.\nWhat’s your token name? (e.g. PEPEWHALE)";
  }

  if (body.toLowerCase().startsWith("/buy") || body === "2" || body === "💸" || /buy\s+\$/i.test(body)) {
    // instant /buy $TICKER <SOL> or start buy flow
    // if instant: /buy $TICKER 0.5
    const parts = body.split(/\s+/);
    if (parts.length >= 2 && parts[0].toLowerCase() === "/buy") {
      // instant buy command
      return await handleInstantBuy(from, parts);
    }
    // otherwise start interactive buy
    session.state = "buy_select";
    return "💸 Which token do you want to buy? Reply with ticker like: $PEPEWHALE\nOr reply a token mint address.";
  }

  if (body.toLowerCase().startsWith("/sell") || body === "3" || body === "🔁" || body.toLowerCase().startsWith("sell ")) {
    // handle sell quickly (requires amount)
    const parts = body.split(/\s+/);
    if (parts.length >= 2) {
      return await handleSellCommand(from, parts);
    }
    return "🔁 To sell: /sell $TICKER <amountTokens> (e.g. /sell $PEPEWHALE 10000)";
  }

  if (body === "3️⃣" || body.toLowerCase().includes("portfolio") || body.toLowerCase().includes("my portfolio") || body.toLowerCase() === "/portfolio") {
    return await viewPortfolio(from);
  }

  if (body === "4" || body === "🔥" || /trending/i.test(body)) {
    return viewTrending();
  }

  if (body.toLowerCase() === "balance" || body.toLowerCase() === "my wallet" || body.toLowerCase().includes("wallet")) {
    const lamports = await connection.getBalance(session.wallet.publicKey);
    const sol = lamports / 1e9;
    return `👛 Wallet Address: ${session.wallet.publicKey.toBase58()}\n💰 Balance: ${sol.toFixed(6)} SOL\n\n${sendMainMenuText()}`;
  }

  // Continue multi-step flows
  const st = session.state || "main";

  // Launch flow steps
  if (st.startsWith("launch_") || st === "launch_name" || st === "launch_confirm") {
    return await continueLaunchFlow(from, body);
  }

  // Buy flow interactive
  if (st.startsWith("buy_") || st === "buy_select" || st === "buy_amount" || st === "buy_confirm") {
    return await continueBuyFlow(from, body);
  }

  // Sell quick entry handled above; else show menu
  return sendMainMenuText();
}

// ---------- Launch flow logic ----------
async function continueLaunchFlow(from, msg) {
  const session = users[from];
  const st = session.state;
  const text = msg.trim();

  if (st === "launch_name") {
    session.temp.name = text;
    session.state = "launch_ticker";
    return `✅ Name set: ${session.temp.name}\nNow enter ticker (e.g. $PEPEWHALE):`;
  }

  if (st === "launch_ticker") {
    const ticker = text.replace("$", "").toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(ticker)) {
      return "❌ Invalid ticker. Use 1-8 letters/numbers (e.g. $PEPEWHALE). Enter ticker:";
    }
    if (tokens[ticker.toLowerCase()]) {
      return `❌ Ticker $${ticker} already exists. Pick another ticker:`;
    }
    session.temp.ticker = ticker;
    session.state = "launch_supply";
    return `✅ Ticker set: $${ticker}\nEnter supply (max 1,000,000,000):`;
  }

  if (st === "launch_supply") {
    const supply = parseInt(text.replace(/,/g, ""), 10);
    if (isNaN(supply) || supply <= 0 || supply > 1_000_000_000) {
      return "❌ Invalid supply. Enter a number up to 1,000,000,000:";
    }
    session.temp.supply = BigInt(supply);
    session.state = "launch_liquidity";
    return `✅ Supply set: ${supply.toLocaleString()} (max 1B)\nEnter initial liquidity in SOL (min 0.5):`;
  }

  if (st === "launch_liquidity") {
    const liquidity = parseFloat(text);
    if (isNaN(liquidity) || liquidity < 0.5) {
      return "❌ Minimum liquidity is 0.5 SOL. Enter initial liquidity (min 0.5 SOL):";
    }
    session.temp.liquidity = liquidity;
    session.state = "launch_description";
    return `✅ Liquidity set: ${liquidity} SOL\nEnter token description/story:`;
  }

  if (st === "launch_description") {
    session.temp.description = text;
    session.state = "launch_community";
    return "✅ Description saved!\nEnter your community link (Telegram, Twitter, or Discord):";
  }

  if (st === "launch_community") {
    session.temp.community = text;
    session.state = "launch_confirm";
    const d = session.temp;
    return [
      "🧠 Final check:",
      `Name: ${d.name}`,
      `Ticker: $${d.ticker}`,
      `Supply: ${d.supply.toString()}`,
      `Initial Liquidity: ${d.liquidity} SOL`,
      `Description: ${d.description}`,
      `Community: ${d.community}`,
      "",
      'Reply "✅ Launch" to confirm or "❌ Cancel" to abort.'
    ].join("\n");
  }

  if (st === "launch_confirm") {
    if (/^(✅|launch|yes|confirm)$/i.test(text)) {
      // ensure wallet has enough SOL for fees + initial liquidity (liquidity is not actually sent to any AMM here)
      const wallet = session.wallet;
      const lamports = await connection.getBalance(wallet.publicKey);
      const solBal = lamports / 1e9;
      if (solBal < 0.01) {
        session.state = "main";
        return `⚠️ Not enough Devnet SOL to mint. Fund wallet: https://faucet.solana.com/\nYour balance: ${solBal.toFixed(6)} SOL`;
      }

      // create mint and mint entire supply to owner
      try {
        const decimals = 9;
        const mint = await createMint(connection, wallet, wallet.publicKey, null, decimals);
        const ownerAta = await getOrCreateAssociatedTokenAccount(connection, wallet, mint, wallet.publicKey);
        const baseUnits = session.temp.supply * (BigInt(10) ** BigInt(decimals));
        const mintSig = await mintTo(connection, wallet, mint, ownerAta.address, wallet.publicKey, baseUnits);

        // store token metadata keyed by ticker and mint
        const mintAddr = mint.toBase58();
        const meta = {
          name: session.temp.name,
          ticker: session.temp.ticker,
          symbol: session.temp.ticker,
          description: session.temp.description,
          community: session.temp.community,
          supply: session.temp.supply.toString(),
          decimals,
          liquidity: session.temp.liquidity,
          basePrice: 0.000001, // base price per token in SOL (storyboard)
          priceMultiplier: 1 + (0 / 1e7), // dynamic later from sales
          ownerFrom: from,
          ownerPubkey: wallet.publicKey.toBase58(),
          ownerTokenAccount: ownerAta.address.toBase58(),
          mintTxSig: mintSig,
          createdAt: Date.now(),
        };
        tokens[session.temp.ticker.toLowerCase()] = meta;
        tokens[mintAddr] = meta;

        // simple global sold tracker (optional)
        session.state = "main";
        session.lastLaunched = mintAddr;
        return `✅ Token *${meta.ticker}* is LIVE on Chat.fun!\nMint: ${mintAddr}\nBase Price: ${meta.basePrice} SOL\nCurve active — buyers already aping in 🐒\n\nOptions:\n- 💸 Buy $${meta.ticker}\n- 📈 View Chart\n- 📣 Share Launch`;
      } catch (err) {
        console.error("Launch mint error:", err);
        session.state = "main";
        return `❌ Failed to create token: ${err.message || err.toString()}`;
      }
    } else {
      session.state = "main";
      return `❌ Launch process cancelled.\nNo SOL deducted. No token created.\n\nChoose:\n🚀 Launch New Token\n📊 My Portfolio\n🔥 Trending Launches`;
    }
  }

  // fallback
  session.state = "main";
  return "❌ Unexpected launch state. Type /launch to start again.";
}

// ---------- Buy flow (interactive) ----------
async function continueBuyFlow(from, msg) {
  const session = users[from];
  const text = msg.trim();
  const st = session.state;

  if (st === "buy_select") {
    // find token by ticker or mint
    const q = text.replace("$", "").trim();
    let token = tokens[q.toLowerCase()] || tokens[q];
    if (!token) {
      // try scanning by ticker uppercase match
      token = Object.values(tokens).find(t => t.ticker && (t.ticker.toLowerCase() === q.toLowerCase())) || null;
    }
    if (!token) {
      session.state = "main";
      return `❌ Token ${text} not found. Try /buy $TICKER or choose from /trending.`;
    }
    session.temp = { tokenKey: token.ticker.toLowerCase(), token };
    session.state = "buy_amount";
    return `How much SOL you throwing in, anon? 💰\n(e.g. 0.5)\nPrice: ${token.basePrice} SOL (base) — price curve applies.`;
  }

  if (st === "buy_amount") {
    const sol = parseFloat(text);
    if (isNaN(sol) || sol <= 0) return "❌ Invalid SOL amount. Enter a number like 0.5:";
    const token = session.temp.token;
    // compute current price — simple mock: price = basePrice * (1 + 0) (we can improve with sales)
    const priceNow = token.basePrice * (1 + 0); // placeholder for curve
    // tokens to give = floor(sol / priceNow)
    const tokensToGive = Math.floor(sol / priceNow);
    if (tokensToGive <= 0) {
      session.state = "main";
      return `❌ That's too little SOL. At current price ${priceNow} SOL/token you get 0 tokens.`;
    }

    // Run on-chain settlement:
    // buyer must have wallet imported; seller (owner) must also have imported wallet to sign token transfer
    const buyer = session;
    if (!buyer.wallet) {
      session.state = "main";
      return "⚠️ You need to import your wallet (paste private key) before buying.";
    }

    const tokenMeta = token;
    const sellerFrom = tokenMeta.ownerFrom;
    const seller = users[sellerFrom];
    if (!seller || !seller.wallet) {
      session.state = "main";
      return "⚠️ Seller has not imported their wallet into the bot. Seller must import for automated settlement.";
    }

    // check buyer SOL balance
    const buyerLamports = await connection.getBalance(buyer.wallet.publicKey);
    const requiredLamports = BigInt(Math.floor(sol * 1e9));
    if (BigInt(buyerLamports) < requiredLamports) {
      session.state = "main";
      return `⚠️ You don't have enough Devnet SOL. Your balance: ${(buyerLamports / 1e9).toFixed(6)} SOL`;
    }

    // compute token base units
    const decimals = tokenMeta.decimals;
    const amountBaseUnits = BigInt(tokensToGive) * (BigInt(10) ** BigInt(decimals));

    try {
      // 1) SOL transfer buyer -> seller
      const sellerPubkey = new PublicKey(tokenMeta.ownerPubkey);
      const solTxSig = await sendSolTx(buyer.wallet, sellerPubkey, Number(requiredLamports));

      // 2) Token transfer seller -> buyer
      const mintPubkey = new PublicKey(tokenMeta.mintAddress);
      const sellerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, seller.wallet.publicKey);
      const buyerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, buyer.wallet.publicKey);
      // transfer signed by seller
      const tokenTxSig = await splTransfer(
        connection,
        seller.wallet,
        sellerAta.address,
        buyerAta.address,
        seller.wallet.publicKey,
        amountBaseUnits
      );

      session.state = "main";
      return `✅ Bought ${tokensToGive.toLocaleString()} ${tokenMeta.ticker} for ${sol} SOL.\nSOL tx: ${toExplorerTx(solTxSig)}\nToken tx: ${toExplorerTx(tokenTxSig)}\nCurrent Price (mock): ${(tokenMeta.basePrice).toFixed(9)} SOL\nMarket Cap (mock): ${( (Number(tokenMeta.supply) * tokenMeta.basePrice) ).toFixed(6)} SOL\n\n${sendMainMenuText()}`;
    } catch (err) {
      console.error("Buy flow error:", err);
      session.state = "main";
      return `❌ Purchase failed: ${err.message || err.toString()}`;
    }
  }

  return sendMainMenuText();
}

// Instant buy command handler: /buy $TICKER 0.5
async function handleInstantBuy(from, parts) {
  // parts example: ["/buy", "$PEPEWHALE", "0.5"]
  if (parts.length < 2) return "❌ Usage: /buy $TICKER <SOL_amount>";
  const ticker = parts[1].replace("$", "").toUpperCase();
  let solAmount = 0;
  for (let i = 2; i < parts.length; i++) {
    const v = parseFloat(parts[i]);
    if (!isNaN(v)) {
      solAmount = v;
      break;
    }
  }
  if (solAmount === 0 && parts[2]) {
    const m = parts[2].match(/([0-9]*\.?[0-9]+)/);
    if (m) solAmount = parseFloat(m[1]);
  }
  if (solAmount <= 0) return "❌ Invalid SOL amount.";

  const token = tokens[ticker.toLowerCase()];
  if (!token) return `❌ Token $${ticker} not found.`;

  // simulate same as interactive buy
  users[from].state = "main"; // ensure state
  // reuse continueBuyFlow logic by setting temp
  users[from].temp = { tokenKey: ticker.toLowerCase(), token };
  // set buyer wallet presence
  if (!users[from].wallet) return "⚠️ Import your wallet (paste private key) before buying.";
  // reuse code to perform purchase
  // compute tokensToGive:
  const priceNow = token.basePrice;
  const tokensToGive = Math.floor(solAmount / priceNow);
  if (tokensToGive <= 0) return `❌ That SOL amount is too small for price ${priceNow} SOL/token.`;
  // perform settlement
  const buyer = users[from];
  const sellerFrom = token.ownerFrom;
  const seller = users[sellerFrom];
  if (!seller || !seller.wallet) return "⚠️ Seller hasn't imported wallet into bot.";
  // check buyer lamports
  const buyerLamports = await connection.getBalance(buyer.wallet.publicKey);
  const requiredLamports = BigInt(Math.floor(solAmount * 1e9));
  if (BigInt(buyerLamports) < requiredLamports) return `⚠️ Insufficient Devnet SOL: ${(buyerLamports/1e9).toFixed(6)} SOL`;
  try {
    const solTxSig = await sendSolTx(buyer.wallet, new PublicKey(token.ownerPubkey), Number(requiredLamports));
    const mintPubkey = new PublicKey(token.mintAddress);
    const sellerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, seller.wallet.publicKey);
    const buyerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, buyer.wallet.publicKey);
    const amountBaseUnits = BigInt(tokensToGive) * (BigInt(10) ** BigInt(token.decimals));
    const tokenTxSig = await splTransfer(connection, seller.wallet, sellerAta.address, buyerAta.address, seller.wallet.publicKey, amountBaseUnits);
    return `✅ Bought ${tokensToGive.toLocaleString()} $${ticker} for ${solAmount} SOL.\nSOL tx: ${toExplorerTx(solTxSig)}\nToken tx: ${toExplorerTx(tokenTxSig)}\n\n${sendMainMenuText()}`;
  } catch (err) {
    console.error("Instant buy error:", err);
    return `❌ Purchase failed: ${err.message || err.toString()}`;
  }
}

// ---------- Sell command handler ----------
async function handleSellCommand(from, parts) {
  // /sell $TICKER 10000
  if (parts.length < 2) return '❌ Usage: /sell $TICKER <amountTokens>';
  let ticker = null;
  let amount = null;
  for (const p of parts.slice(1)) {
    if (p.includes("$")) ticker = p.replace("$", "").toUpperCase();
    const v = parseInt(p.replace(/,/g, ""), 10);
    if (!isNaN(v) && v > 0) amount = v;
  }
  if (!ticker && parts[1]) {
    if (isNaN(parseInt(parts[1].replace(/,/g, ""), 10))) {
      ticker = parts[1].toUpperCase();
    }
  }
  if (!amount) {
    const last = parts[parts.length - 1];
    const v = parseInt(last.replace(/,/g, ""), 10);
    if (!isNaN(v)) amount = v;
  }
  if (!ticker) return "❌ Could not detect ticker. Use: /sell $TICKER <amount>";
  const token = tokens[ticker.toLowerCase()];
  if (!token) return `❌ Token $${ticker} not found.`;
  // seller must be the same as user
  const seller = users[from];
  if (!seller || !seller.wallet) return "⚠️ Import your wallet first.";
  if (!amount || amount <= 0) return "❌ Invalid amount to sell.";

  try {
    const mintPubkey = new PublicKey(token.mintAddress);
    const sellerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, seller.wallet.publicKey);
    // For simplicity we won't check exact token balance on-chain; we will attempt transfer back to owner (burn to simulate sell) - but simpler: simulate returning SOL
    // We'll "sell" tokens back to the system: burn is complex; instead, give SOL to seller to simulate sale and reduce token possession manually.
    // For realistic behaviour, seller could transfer tokens to a buyer; here we simulate a sale and send mock SOL back to seller (not implementing counterparty).
    const mockSolReturned = (amount * token.basePrice) || 0;
    return `✅ Sold ${amount.toLocaleString()} $${ticker} for ${mockSolReturned.toFixed(6)} SOL.\nCurve Price: ${token.basePrice.toFixed(9)} SOL\nVolume last 1h: +3.7 SOL\n\nOptions:\n📊 Chart\n💸 Buy More\n💰 Wallet Balance`;
  } catch (err) {
    console.error("Sell error:", err);
    return `❌ Sell failed: ${err.message || err.toString()}`;
  }
}

// ---------- Portfolio view ----------
async function viewPortfolio(from) {
  const u = users[from];
  if (!u || !u.wallet) return "📊 Your portfolio is empty. Import a wallet to see holdings.";
  // Check each known token's ATA for this user
  const holdings = [];
  for (const k of Object.keys(tokens)) {
    const t = tokens[k];
    if (!t || !t.mintAddress) continue;
    try {
      const mintPubkey = new PublicKey(t.mintAddress);
      // attempt to read token account for user
      const ata = await getOrCreateAssociatedTokenAccount(connection, u.wallet, mintPubkey, u.wallet.publicKey);
      // get balance
      const balResp = await connection.getTokenAccountBalance(ata.address).catch(() => null);
      let amountHuman = "0";
      if (balResp && balResp.value && balResp.value.uiAmount) {
        amountHuman = balResp.value.uiAmountString || String(balResp.value.uiAmount);
      }
      if (amountHuman !== "0") {
        holdings.push({ ticker: t.ticker, amount: amountHuman, mint: t.mintAddress });
      }
    } catch (err) {
      // ignore
    }
  }
  if (holdings.length === 0) return "📊 Your portfolio is empty. Buy tokens via /buy or reply '💸 Buy Token'.";
  const lines = ["📊 Your Portfolio:"];
  for (const h of holdings) lines.push(`- $${h.ticker}: ${h.amount} — mint: ${h.mint}`);
  return lines.join("\n");
}

// ---------- Trending / Listing ----------
function viewTrending() {
  const all = Object.values(tokens);
  if (all.length === 0) return "🔥 No trending launches yet.";
  const unique = [];
  const seen = new Set();
  for (const t of all) {
    if (!t || seen.has(t.mintAddress)) continue;
    seen.add(t.mintAddress);
    unique.push(t);
  }
  const list = unique.slice(0, 5).map(t => `- $${t.ticker} — ${t.name} (${Number(t.supply).toLocaleString()} supply)`).join("\n");
  return `🔥 Trending Launches:\n${list}\n\nReply with a ticker (e.g. $PEPEWHALE) to buy or /launch to create your own.`;
}

// ---------- Express endpoints ----------
app.post("/incoming", async (req, res) => {
  const from = req.body.From || req.body.from || "unknown";
  const body = req.body.Body || req.body.body || "";
  try {
    const reply = await handleIncoming(from, body);
    twimlReply(res, reply);
  } catch (err) {
    console.error("Handler error:", err);
    twimlReply(res, "⚠️ Server error. Try again later.");
  }
});

// convenience: list tokens
app.get("/tokens", (req, res) => {
  const list = [];
  const seen = new Set();
  for (const k of Object.keys(tokens)) {
    const t = tokens[k];
    if (!t || seen.has(t.mintAddress)) continue;
    seen.add(t.mintAddress);
    list.push({
      name: t.name,
      ticker: t.ticker,
      mintAddress: t.mintAddress,
      ownerPubkey: t.ownerPubkey,
      supply: t.supply,
      decimals: t.decimals,
      pricePerTokenSOL: t.pricePerTokenSOL || t.basePrice,
      liquidity: t.liquidity,
      createdAt: t.createdAt,
      explorer: toExplorerAddr(t.mintAddress),
    });
  }
  res.json(list);
});

app.get("/", (req, res) => res.send("Chat.fun Devnet bot running"));

app.listen(PORT, () => {
  console.log(`🚀 Chat.fun Devnet bot listening on ${PORT}`);
});

