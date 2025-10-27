/**
 * index.js
 * Chat.fun WhatsApp bot — Realistic Devnet token launch + buy flow
 *
 * - Users import their Solana private key (JSON array or base58)
 * - Launch flow collects name, symbol, story, total supply, decimals, price per token, freeze authority
 * - Launch mints tokens to launcher's wallet (Devnet)
 * - Buy flow performs:
 *    1) SOL transfer from buyer -> seller (signed by buyer)
 *    2) token transfer from seller -> buyer (signed by seller)
 * - Returns mint address + transaction signatures + explorer links
 *
 * WARNING: This stores private keys in server memory for the session. Only use on Devnet and for testing.
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
  transfer,
} from "@solana/spl-token";

const app = express();
// Twilio expects urlencoded body for incoming webhooks
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
// You can set these env variables in Render or replace with inline strings for quick testing
const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || ""; // optional for sending; not required for TwiML replies
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

// Twilio client (only needed if you want to send outbound messages from server — TwiML replies don't need it)
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// ---------- Solana Devnet connection ----------
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// ---------- In-memory stores ----------
const users = {}; // { from: { state, wallet: Keypair, temp... } }
const tokens = {}; // { tokenKey (lowercase name or mint): { name, symbol, story, mintAddress, decimals, totalSupply, pricePerTokenSOL, ownerFrom, ownerPubkey } }

// ---------- Helpers ----------
function sendTwimlResponse(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type("text/xml").send(twiml.toString());
}

function isLikelyPrivateKey(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return true;
  const words = trimmed.split(/\s+/);
  if (words.length >= 12 && words.length <= 24) return true;
  if (/^[A-HJ-NP-Za-km-z1-9]{32,100}$/.test(trimmed)) return true;
  return false;
}

async function importWalletFromText(text) {
  try {
    let keypair;
    const raw = text.trim();
    if (raw.startsWith("[")) {
      // JSON array
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } else {
      // base58
      keypair = Keypair.fromSecretKey(bs58.decode(raw));
    }
    return { success: true, keypair };
  } catch (err) {
    return { success: false, error: err };
  }
}

function toExplorerAddressLink(addr) {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

function toExplorerTxLink(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// ---------- Blockchain helpers ----------
async function sendSol(fromKeypair, toPubkey, lamports) {
  // build tx with SystemProgram.transfer signed by fromKeypair
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPubkey,
      lamports: Number(lamports),
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
  return sig;
}

async function transferTokens(mintPubkey, ownerKeypair, ownerTokenAccountAddress, destOwnerPubkey, amountBaseUnits, decimals) {
  // Ensure buyer associated token account exists (we will create via getOrCreateAssociatedTokenAccount with buyer as payer)
  // Note: this function assumes caller will ensure buyer has created ATA or uses ownerKeypair as payer to create buyer ATA (we'll create with owner as payer for simplicity)
  const destAta = await getOrCreateAssociatedTokenAccount(connection, ownerKeypair, mintPubkey, destOwnerPubkey);
  // ownerTokenAccountAddress is the source token account (owner's)
  const sig = await transfer(
    connection,
    ownerKeypair, // payer for fees and signer
    ownerTokenAccountAddress,
    destAta.address,
    ownerKeypair.publicKey, // owner of source account
    BigInt(amountBaseUnits)
  );
  return { sig, destAta: destAta.address.toBase58() };
}

// ---------- Conversation flow ----------
// We'll follow the exact flow you requested, with an added step to set price per token (SOL) so buys can calculate amounts.
// Steps for launch:
// 1 name -> 2 symbol -> 3 story -> 4 total supply -> 5 decimals -> 6 price per token (SOL) -> 7 freeze authority yes/no -> 8 summary and confirm

async function handleIncoming(from, incomingText) {
  const text = (incomingText || "").trim();
  users[from] = users[from] || { state: "idle" };

  // quick wallet import if message looks like a private key and user hasn't imported
  if (!users[from].wallet && isLikelyPrivateKey(text)) {
    const imp = await importWalletFromText(text);
    if (imp.success) {
      users[from].wallet = imp.keypair;
      users[from].state = "idle";
      const lamports = await connection.getBalance(imp.keypair.publicKey);
      const solBal = lamports / 1e9;
      return `✅ Wallet imported!\nAddress: ${imp.keypair.publicKey.toBase58()}\nBalance: ${solBal.toFixed(6)} SOL (Devnet)\n\nType "launch token" to start a token launch or "buy" to buy a token.`;
    } else {
      return "❌ Couldn't import that key. Paste a valid base58 private key or JSON array.";
    }
  }

  // state machine
  const st = users[from].state;

  // start commands
  if (/^launch token$/i.test(text) && (!st || st === "idle")) {
    users[from].state = "launch_name";
    users[from].temp = {};
    return "🚀 Enter token name:";
  }

  if (/^buy$/i.test(text) && (!st || st === "idle")) {
    users[from].state = "buy_choose";
    return "💸 Enter token name or mint address you want to buy:";
  }

  // Launch flow
  if (st && st.startsWith("launch_")) {
    const tmp = users[from].temp;
    switch (st) {
      case "launch_name":
        tmp.name = text;
        users[from].state = "launch_symbol";
        return "Enter symbol (e.g. SWF):";

      case "launch_symbol":
        tmp.symbol = text.toUpperCase();
        users[from].state = "launch_story";
        return "Describe your token’s story or purpose:";

      case "launch_story":
        tmp.story = text;
        users[from].state = "launch_supply";
        return "Enter total supply (whole number, e.g. 1000000000):";

      case "launch_supply":
        if (!/^\d+$/.test(text)) return "❌ Invalid supply. Enter a whole number (e.g. 1000000000):";
        tmp.supply = BigInt(text);
        users[from].state = "launch_decimals";
        return "Enter decimals (usually 9):";

      case "launch_decimals":
        if (!/^\d+$/.test(text)) return "❌ Invalid decimals. Enter a number (e.g. 9):";
        tmp.decimals = parseInt(text, 10);
        users[from].state = "launch_price";
        return "Enter price per token in SOL (e.g. 0.0001) — this will be used for buys on Devnet:";

      case "launch_price":
        {
          const v = parseFloat(text);
          if (Number.isNaN(v) || v <= 0) return "❌ Invalid price. Enter a number like 0.0001:";
          tmp.pricePerTokenSOL = v;
          users[from].state = "launch_freeze";
          return "Set a freeze authority? (yes/no):";
        }

      case "launch_freeze":
        tmp.freeze = (/^y(es)?$/i.test(text));
        // summary
        users[from].state = "launch_confirm";
        return (
          `🧾 Confirm launch details:\n\n` +
          `Name: ${tmp.name}\n` +
          `Symbol: ${tmp.symbol}\n` +
          `Story: ${tmp.story}\n` +
          `Total Supply: ${tmp.supply.toString()}\n` +
          `Decimals: ${tmp.decimals}\n` +
          `Price (SOL per token): ${tmp.pricePerTokenSOL}\n` +
          `Freeze Authority: ${tmp.freeze ? "Yes" : "No"}\n\n` +
          `Type "confirm" to deploy to Devnet or "cancel" to abort.`
        );

      case "launch_confirm":
        if (/^confirm$/i.test(text)) {
          // Perform actual mint
          const wallet = users[from].wallet;
          if (!wallet) {
            users[from].state = "idle";
            return "⚠️ Please import your wallet private key first (paste it here).";
          }

          // check wallet balance
          const lamports = await connection.getBalance(wallet.publicKey);
          const solBal = lamports / 1e9;
          if (solBal < 0.01) {
            users[from].state = "idle";
            return `⚠️ Not enough Devnet SOL (need at least 0.01). Fund your wallet via https://faucet.solana.com/ and try again.\nYour address: ${wallet.publicKey.toBase58()}`;
          }

          // Create mint
          try {
            const mint = await createMint(connection, wallet, wallet.publicKey, tmp.freeze ? wallet.publicKey : null, tmp.decimals);
            // Create ATA and mint total supply (convert supply to base units)
            const ownerAta = await getOrCreateAssociatedTokenAccount(connection, wallet, mint, wallet.publicKey);
            const baseUnits = tmp.supply * (BigInt(10) ** BigInt(tmp.decimals));
            const mintSig = await mintTo(connection, wallet, mint, ownerAta.address, wallet.publicKey, baseUnits);

            // Store token metadata in tokens map under name and mint
            const mintAddr = mint.toBase58();
            tokens[tmp.name.toLowerCase()] = {
              name: tmp.name,
              symbol: tmp.symbol,
              story: tmp.story,
              mintAddress: mintAddr,
              decimals: tmp.decimals,
              totalSupply: tmp.supply.toString(),
              pricePerTokenSOL: tmp.pricePerTokenSOL,
              ownerFrom: from,
              ownerPubkey: wallet.publicKey.toBase58(),
              ownerTokenAccount: ownerAta.address.toBase58(),
              mintTxSig: mintSig,
              createdAt: Date.now(),
            };
            // also index by mint
            tokens[mintAddr] = tokens[tmp.name.toLowerCase()];

            users[from].state = "idle";
            users[from].lastMint = mintAddr;
            return (
              `✅ Token launched successfully!\n\n` +
              `Name: ${tmp.name}\n` +
              `Symbol: ${tmp.symbol}\n` +
              `Mint: ${mintAddr}\n` +
              `Mint Tx: ${mintSig}\n` +
              `Explorer: ${toExplorerAddressLink(mintAddr)}\n\n` +
              `You minted ${tmp.supply.toString()} tokens (decimals ${tmp.decimals}).`
            );
          } catch (err) {
            console.error("Mint error:", err);
            users[from].state = "idle";
            return `❌ Token mint failed: ${err.message || err.toString()}`;
          }
        } else {
          users[from].state = "idle";
          return "❌ Launch cancelled. Type 'launch token' to start again.";
        }

      default:
        users[from].state = "idle";
        return "⚠️ Unknown launch state. Type 'launch token' to start again.";
    }
  }

  // Buy flow
  if (st && st.startsWith("buy_") || st === "buy_choose") {
    // buy_choose -> user provides token name or mint -> buy_amount -> confirmation -> execute
    if (st === "buy_choose") {
      // find token by name or mint
      const key = text.toLowerCase();
      const token = tokens[key] || tokens[text]; // match by name or mint
      if (!token) {
        users[from].state = "idle";
        return "❌ Token not found. Make sure you typed the token name exactly or paste its mint address. Type 'buy' to try again.";
      }
      users[from].state = "buy_amount";
      users[from].temp = { tokenKey: key === text ? text : key, token }; // store both
      return `Found token: ${token.name} (${token.symbol})\nPrice: ${token.pricePerTokenSOL} SOL per token\nHow much SOL will you spend to buy? (e.g. 0.1)`;
    }

    if (st === "buy_amount") {
      const sol = parseFloat(text);
      if (Number.isNaN(sol) || sol <= 0) {
        return "❌ Invalid amount. Enter SOL amount like 0.1";
      }
      users[from].temp.solAmount = sol;
      const token = users[from].temp.token;
      const tokensToReceive = Math.floor(sol / token.pricePerTokenSOL);
      if (tokensToReceive <= 0) {
        users[from].state = "idle";
        return `❌ That SOL amount is too small for the token price (${token.pricePerTokenSOL} SOL per token).`;
      }
      users[from].temp.tokensToReceive = tokensToReceive;
      users[from].state = "buy_confirm";
      return `You will buy approx ${tokensToReceive} ${token.symbol} for ${sol} SOL.\nType 'confirm' to execute the trade or 'cancel' to abort.`;
    }

    if (st === "buy_confirm") {
      if (!/^confirm$/i.test(text)) {
        users[from].state = "idle";
        return "❌ Purchase cancelled.";
      }

      // execute purchase: requires buyer wallet and seller wallet imported
      const buyer = users[from];
      if (!buyer || !buyer.wallet) {
        users[from].state = "idle";
        return "⚠️ You must import your wallet private key first (paste it here).";
      }

      const token = buyer.temp.token;
      const sellerFrom = token.ownerFrom;
      const seller = users[sellerFrom];
      if (!seller || !seller.wallet) {
        users[from].state = "idle";
        return "⚠️ Seller must have imported their wallet into the bot for automatic settlement. Seller hasn't imported their wallet.";
      }

      // checks: buyer has enough SOL
      const buyerLamports = await connection.getBalance(buyer.wallet.publicKey);
      const requiredLamports = BigInt(Math.floor(buyer.temp.solAmount * 1e9));
      if (BigInt(buyerLamports) < requiredLamports) {
        users[from].state = "idle";
        return `⚠️ You don't have enough Devnet SOL. Your balance: ${(buyerLamports / 1e9).toFixed(6)} SOL`;
      }

      // check seller has enough tokens
      // get seller ATA for mint
      const mintPubkey = new PublicKey(token.mintAddress);
      const sellerTokenAccountInfo = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, seller.wallet.publicKey);
      // amount available - vault?
      // (We won't parse token account amount via RPC here - we assume minted supply went to ownerATA and is enough)
      // compute token units to transfer in base units:
      const tokensToSend = BigInt(buyer.temp.tokensToReceive) * (BigInt(10) ** BigInt(token.decimals));

      // Transfer SOL from buyer to seller
      try {
        const solTxSig = await sendSol(buyer.wallet, new PublicKey(token.ownerPubkey), requiredLamports);
        // Transfer tokens from seller -> buyer
        // ensure buyer ATA exists
        const buyerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, buyer.wallet.publicKey);
        // Now run transfer signed by seller (owner of tokens). Use transfer() from spl-token
        const tokenTransferSig = await transfer(
          connection,
          seller.wallet, // payer and signer
          sellerTokenAccountInfo.address, // source
          buyerAta.address, // destination
          seller.wallet.publicKey, // owner of source
          tokensToSend
        );

        // finalize
        users[from].state = "idle";
        return (
          `✅ Purchase complete!\n\n` +
          `You sent: ${(Number(buyer.temp.solAmount)).toFixed(6)} SOL\n` +
          `SOL tx: ${solTxSig}\n` +
          `Token tx: ${tokenTransferSig}\n\n` +
          `You received approx ${buyer.temp.tokensToReceive} ${token.symbol}\n` +
          `Mint: ${token.mintAddress}\n` +
          `Explorer (SOL tx): ${toExplorerTxLink(solTxSig)}\n` +
          `Explorer (Token tx): ${toExplorerTxLink(tokenTransferSig)}\n\n` +
          `Thanks for using Chat.fun Devnet marketplace!`
        );
      } catch (err) {
        console.error("Buy error:", err);
        users[from].state = "idle";
        return `❌ Purchase failed: ${err.message || err.toString()}`;
      }
    }
  }

  // If user typed 'balance' or 'wallet'
  if (/^(balance|wallet|my wallet)$/i.test(text)) {
    const u = users[from];
    if (!u || !u.wallet) return "⚠️ No wallet found. Paste your private key to import.";
    const lamports = await connection.getBalance(u.wallet.publicKey);
    return `👛 Wallet: ${u.wallet.publicKey.toBase58()}\nBalance: ${(lamports / 1e9).toFixed(6)} SOL (Devnet)`;
  }

  // Quick help
  if (/^(help|menu|start)$/i.test(text)) {
    return `Chat.fun commands:\n- launch token  → Start a token launch\n- buy           → Buy a token\n- paste private key → Import your wallet (base58 or JSON)\n- balance       → Show your Devnet SOL balance`;
  }

  return "I didn't understand that. Type 'help' for commands.";
}

// ---------- Express route (Twilio webhook) ----------
app.post("/incoming", async (req, res) => {
  const from = req.body.From || req.body.from || "unknown";
  const body = req.body.Body || req.body.body || "";

  try {
    const reply = await handleIncoming(from, body);
    sendTwimlResponse(res, reply);
  } catch (err) {
    console.error("Webhook error:", err);
    sendTwimlResponse(res, "⚠️ Server error. Try again later.");
  }
});

// A simple route to list launched tokens (for convenience)
app.get("/tokens", (req, res) => {
  // return tokens array (dedupe by mint)
  const seen = new Set();
  const list = [];
  for (const key of Object.keys(tokens)) {
    const t = tokens[key];
    if (!t || seen.has(t.mintAddress)) continue;
    seen.add(t.mintAddress);
    list.push({
      name: t.name,
      symbol: t.symbol,
      mintAddress: t.mintAddress,
      owner: t.ownerPubkey,
      pricePerTokenSOL: t.pricePerTokenSOL,
      decimals: t.decimals,
      totalSupply: t.totalSupply,
      createdAt: t.createdAt,
      mintTxSig: t.mintTxSig,
      explorer: toExplorerAddressLink(t.mintAddress),
    });
  }
  res.json(list);
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`🚀 Chat.fun Devnet bot running on port ${PORT}`);
  console.log(`Webhook endpoint: POST /incoming`);
});
