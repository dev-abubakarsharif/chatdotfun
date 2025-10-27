/**
 * index.js
 * Chat.fun Devnet bot — realistic token launch + buy (fixed)
 *
 * Notes:
 * - Devnet only. For testing only.
 * - Stores private keys in memory (NOT safe for production).
 * - Twilio TwiML replies (POST /incoming).
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
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// -------- config --------
const PORT = process.env.PORT || 3000;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";
// Twilio client is not required for TwiML replies, so we don't depend on SID/TOKEN here

// -------- solana devnet connection --------
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// -------- in-memory stores --------
const users = {}; // { from: { state, wallet: Keypair, temp: {...}, lastMint } }
const tokens = {}; // keyed by lowercase name and by mint address

// -------- helpers --------
function sendTwimlResponse(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type("text/xml").send(twiml.toString());
}

function toExplorerAddressLink(addr) {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}
function toExplorerTxLink(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function isLikelyPrivateKey(text) {
  const t = text.trim();
  if (t.startsWith("[")) return true;
  const words = t.split(/\s+/);
  if (words.length >= 12 && words.length <= 24) return true;
  if (/^[A-HJ-NP-Za-km-z1-9]{32,100}$/.test(t)) return true;
  return false;
}

async function importWalletFromText(text) {
  try {
    let keypair;
    const raw = text.trim();
    if (raw.startsWith("[")) {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } else {
      keypair = Keypair.fromSecretKey(bs58.decode(raw));
    }
    return { success: true, keypair };
  } catch (err) {
    return { success: false, error: err };
  }
}

async function sendSol(fromKeypair, toPubkey, lamportsNumber) {
  // lamportsNumber should be a Number (JS)
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPubkey,
      lamports: lamportsNumber,
    })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
  return sig;
}

// ---------- main conversation handler ----------
async function handleIncoming(from, incomingText) {
  const text = (incomingText || "").trim();
  users[from] = users[from] || { state: "idle" };

  // Quick private-key import: user pastes base58 or JSON
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

  const st = users[from].state;

  // starter commands
  if (/^launch token$/i.test(text) && (!st || st === "idle")) {
    users[from].state = "launch_name";
    users[from].temp = {};
    return "🚀 Let's launch your token on Solana Devnet.\n\nEnter token name:";
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
        if (!text) return "Enter token name:";
        tmp.name = text;
        users[from].state = "launch_symbol";
        return "Enter symbol (e.g. SWF):";

      case "launch_symbol":
        if (!text) return "Enter symbol (e.g. SWF):";
        tmp.symbol = text.toUpperCase();
        users[from].state = "launch_story";
        return "Describe your token’s story or purpose:";

      case "launch_story":
        tmp.story = text || "";
        users[from].state = "launch_supply";
        return "Enter total supply (whole number, e.g. 1000000000):";

      case "launch_supply":
        if (!/^\d+$/.test(text)) return "❌ Invalid supply. Enter whole number (e.g. 1000000000):";
        tmp.supply = BigInt(text);
        users[from].state = "launch_decimals";
        return "Enter decimals (usually 9):";

      case "launch_decimals":
        if (!/^\d+$/.test(text)) return "❌ Invalid decimals. Enter a number (e.g. 9):";
        tmp.decimals = parseInt(text, 10);
        users[from].state = "launch_price";
        return "Enter price per token in SOL (e.g. 0.0001) — used for buys on Devnet:";

      case "launch_price": {
        const v = parseFloat(text);
        if (Number.isNaN(v) || v <= 0) return "❌ Invalid price. Enter a positive number like 0.0001:";
        tmp.pricePerTokenSOL = v;
        users[from].state = "launch_freeze";
        return "Set a freeze authority? (yes/no):";
      }

      case "launch_freeze":
        tmp.freeze = /^y(es)?$/i.test(text);
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
          `Type "confirm" to deploy or "cancel" to abort.`
        );

      case "launch_confirm":
        if (!/^confirm$/i.test(text)) {
          users[from].state = "idle";
          return "❌ Launch cancelled. Type 'launch token' to start again.";
        }

        // perform mint
        const wallet = users[from].wallet;
        if (!wallet) {
          users[from].state = "idle";
          return "⚠️ Please import your wallet first (paste your private key).";
        }

        // ensure small devnet balance for fees
        const walletLamports = await connection.getBalance(wallet.publicKey);
        const walletSol = walletLamports / 1e9;
        if (walletSol < 0.005) {
          users[from].state = "idle";
          return `⚠️ Not enough Devnet SOL (need at least ~0.005). Use https://faucet.solana.com/ to top up.\nYour address: ${wallet.publicKey.toBase58()}`;
        }

        try {
          const mint = await createMint(connection, wallet, wallet.publicKey, tmp.freeze ? wallet.publicKey : null, tmp.decimals);
          const ownerAta = await getOrCreateAssociatedTokenAccount(connection, wallet, mint, wallet.publicKey);
          const baseUnits = tmp.supply * (BigInt(10) ** BigInt(tmp.decimals));
          const mintSig = await mintTo(connection, wallet, mint, ownerAta.address, wallet.publicKey, baseUnits);

          const mintAddr = mint.toBase58();
          const metadata = {
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

          tokens[tmp.name.toLowerCase()] = metadata;
          tokens[mintAddr] = metadata;

          users[from].state = "idle";
          users[from].lastMint = mintAddr;
          return (
            `✅ Token launched!\n\n` +
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

      default:
        users[from].state = "idle";
        return "⚠️ Unknown launch state. Type 'launch token' to start.";
    }
  }

  // Buy flow (fixed precedence)
  if (st && (st.startsWith("buy_") || st === "buy_choose")) {
    // buy_choose: user provided token name / mint
    if (st === "buy_choose") {
      const keyLower = text.toLowerCase();
      let token = tokens[keyLower] || tokens[text];
      // also attempt to match exact mint if user pasted that
      if (!token && /[A-Za-z0-9]{32,}/.test(text)) token = tokens[text];
      if (!token) {
        users[from].state = "idle";
        return "❌ Token not found. Type 'buy' and paste the token name (case-sensitive) or mint address to try again.";
      }
      users[from].temp = { token };
      users[from].state = "buy_amount";
      return `Found token: ${token.name} (${token.symbol}) — Price: ${token.pricePerTokenSOL} SOL per token\nHow much SOL will you spend? (e.g. 0.1)`;
    }

    if (st === "buy_amount") {
      const sol = parseFloat(text);
      if (Number.isNaN(sol) || sol <= 0) return "❌ Invalid SOL amount. Enter a number like 0.1";
      users[from].temp.solAmount = sol;
      const token = users[from].temp.token;
      const tokensToReceive = Math.floor(sol / token.pricePerTokenSOL);
      if (tokensToReceive <= 0) {
        users[from].state = "idle";
        return `❌ That SOL amount is too small for price ${token.pricePerTokenSOL} SOL/token.`;
      }
      users[from].temp.tokensToReceive = tokensToReceive;
      users[from].state = "buy_confirm";
      return `You will receive approx ${tokensToReceive} ${token.symbol} for ${sol} SOL.\nType 'confirm' to execute or 'cancel' to abort.`;
    }

    if (st === "buy_confirm") {
      if (!/^confirm$/i.test(text)) {
        users[from].state = "idle";
        return "❌ Purchase cancelled.";
      }

      // buyer must have imported wallet
      const buyer = users[from];
      if (!buyer || !buyer.wallet) {
        users[from].state = "idle";
        return "⚠️ Import your wallet first (paste your private key).";
      }

      const token = buyer.temp.token;
      const sellerFrom = token.ownerFrom;
      const seller = users[sellerFrom];
      if (!seller || !seller.wallet) {
        users[from].state = "idle";
        return `⚠️ Seller has not imported their wallet into the bot. Seller (${token.ownerFrom}) must import for automatic settlement.`;
      }

      // check buyer SOL balance
      const buyerLamports = await connection.getBalance(buyer.wallet.publicKey);
      const requiredLamports = BigInt(Math.floor(buyer.temp.solAmount * 1e9));
      if (BigInt(buyerLamports) < requiredLamports) {
        users[from].state = "idle";
        return `⚠️ Insufficient Devnet SOL. Your balance: ${(buyerLamports / 1e9).toFixed(6)} SOL`;
      }

      try {
        // transfer SOL buyer -> seller
        const solTxSig = await sendSol(buyer.wallet, new PublicKey(token.ownerPubkey), Number(requiredLamports));

        // transfer tokens seller -> buyer
        const mintPubkey = new PublicKey(token.mintAddress);
        // ensure seller's ATA exists (it should)
        const sellerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, seller.wallet.publicKey);
        // create buyer ATA (paid by seller to avoid requiring buyer extra SOL; seller pays fee)
        const buyerAta = await getOrCreateAssociatedTokenAccount(connection, seller.wallet, mintPubkey, buyer.wallet.publicKey);
        const tokensToSendBase = BigInt(buyer.temp.tokensToReceive) * (BigInt(10) ** BigInt(token.decimals));

        const tokenTransferSig = await transfer(
          connection,
          seller.wallet,
          sellerAta.address,
          buyerAta.address,
          seller.wallet.publicKey,
          tokensToSendBase
        );

        users[from].state = "idle";
        return (
          `✅ Purchase complete!\n\n` +
          `You paid: ${(buyer.temp.solAmount).toFixed(6)} SOL\n` +
          `SOL tx: ${solTxSig}\n` +
          `Token tx: ${tokenTransferSig}\n\n` +
          `You received approx ${buyer.temp.tokensToReceive} ${token.symbol}\n` +
          `Mint: ${token.mintAddress}\n` +
          `Explorer (SOL tx): ${toExplorerTxLink(solTxSig)}\n` +
          `Explorer (Token tx): ${toExplorerTxLink(tokenTransferSig)}`
        );
      } catch (err) {
        console.error("Buy error:", err);
        users[from].state = "idle";
        return `❌ Purchase failed: ${err.message || err.toString()}`;
      }
    }
  }

  // wallet / balance query
  if (/^(balance|wallet|my wallet)$/i.test(text)) {
    const u = users[from];
    if (!u || !u.wallet) return "⚠️ No wallet found. Paste your private key to import (base58 or JSON).";
    const lamports = await connection.getBalance(u.wallet.publicKey);
    return `👛 Wallet: ${u.wallet.publicKey.toBase58()}\nBalance: ${(lamports / 1e9).toFixed(6)} SOL (Devnet)`;
  }

  if (/^(help|menu|start)$/i.test(text)) {
    return `Commands:\n- launch token  → start launch flow\n- buy           → buy a token\n- paste private key → import your wallet (base58 or JSON)\n- balance       → show Devnet SOL balance`;
  }

  return "I didn't understand. Type 'help' for commands.";
}

// ---------- endpoint ----------
app.post("/incoming", async (req, res) => {
  const from = req.body.From || req.body.from || "unknown";
  const body = req.body.Body || req.body.body || "";
  try {
    const reply = await handleIncoming(from, body);
    sendTwimlResponse(res, reply);
  } catch (err) {
    console.error("Webhook handler error:", err);
    sendTwimlResponse(res, "⚠️ Server error. Try again later.");
  }
});

// utility listing route
app.get("/tokens", (req, res) => {
  const seen = new Set();
  const list = [];
  for (const k of Object.keys(tokens)) {
    const t = tokens[k];
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
      mintTxSig: t.mintTxSig,
      explorer: toExplorerAddressLink(t.mintAddress),
    });
  }
  res.json(list);
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`🚀 Chat.fun Devnet bot running on port ${PORT}`);
  console.log(`POST /incoming is your Twilio webhook endpoint`);
});
