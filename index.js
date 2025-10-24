/**
 * index.js
 * Chat.fun WhatsApp bot MVP (Twilio) - Render ready
 *
 * - Supports JSON array or base58 private key (single string)
 * - Fetches and displays wallet balance after import
 * - Keeps simple launch/buy/sell menu flow
 */

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import bs58 from "bs58";
import { Keypair, Connection, clusterApiUrl } from "@solana/web3.js";

// Environment variables
const app = express();
const PORT = process.env.PORT || 3000;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- In-memory user store ---
const users = {}; // { phone: { state, wallet } }

// --- Solana connection ---
const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");

// --- Menu generator ---
function sendMainMenu() {
  return (
    "You’re ready to cook, anon 🔥\n\n" +
    "1️⃣ Launch Token\n" +
    "2️⃣ Buy Token\n" +
    "3️⃣ Sell Token\n" +
    "4️⃣ My Wallet\n\n" +
    "Reply with a number:"
  );
}

// --- Wallet import handler ---
async function tryImportWallet(from, rawText) {
  try {
    let keypair;
    const text = rawText.trim();

    // Try both JSON array and base58 string formats
    try {
      // JSON array format
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
    } catch {
      // Base58 format
      keypair = Keypair.fromSecretKey(bs58.decode(text));
    }

    users[from] = { ...users[from], wallet: keypair, state: "main" };

    // Fetch wallet balance
    const publicKey = keypair.publicKey;
    let balanceSol = 0;
    try {
      const lamports = await connection.getBalance(publicKey);
      balanceSol = lamports / 1e9; // convert lamports → SOL
    } catch (err) {
      console.error("Error fetching balance:", err);
    }

    return {
      success: true,
      message:
        `✅ Wallet imported successfully!\n` +
        `📍 Address: ${publicKey.toBase58()}\n` +
        `💰 Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
        sendMainMenu(),
    };
  } catch (err) {
    console.error("Wallet import failed:", err);
    return { success: false, message: "❌ Invalid wallet format. Try again." };
  }
}

// --- Message handler ---
async function handleIncoming(from, rawBody) {
  const body = rawBody.trim();
  const user = users[from] || { state: "onboarding" };

  if (body.toLowerCase() === "hi" || body.toLowerCase() === "hello") {
    users[from] = { state: "awaiting_import" };
    return (
      "👋 Welcome to Chat.fun\n" +
      "Paste your Solana private key to connect your wallet.\n\n" +
      "Example:\n" +
      "`t2xbg6kkB812NHPPWcUE3HyQwwEsiKGHgLiQ8jLodQwuYjQ8iHz7wfmGjzNkCZDnB21GmBgUkmggs11PwQGc3H1`"
    );
  }

  // Import wallet
  if (user.state === "awaiting_import") {
    const r = await tryImportWallet(from, body);
    return r.message;
  }

  // Main menu actions
  if (user.state === "main") {
    switch (body) {
      case "1":
        return "🚀 Token Launch flow coming soon...";
      case "2":
        return "💸 Token Buy flow coming soon...";
      case "3":
        return "🔁 Token Sell flow coming soon...";
      case "4": {
        const wallet = user.wallet;
        if (!wallet) return "⚠️ No wallet found. Please import again.";
        const balanceLamports = await connection.getBalance(wallet.publicKey);
        const balanceSol = balanceLamports / 1e9;
        return (
          `👛 Wallet Address: ${wallet.publicKey.toBase58()}\n` +
          `💰 Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
          sendMainMenu()
        );
      }
      default:
        return "❓ Invalid choice. Please select 1, 2, 3, or 4.";
    }
  }

  return "Type 'Hi' to start.";
}

// --- Twilio webhook ---
app.post("/incoming", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  const reply = await handleIncoming(from, body);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// --- Start server ---
app.listen(PORT, () => console.log(`🚀 Chat.fun bot running on port ${PORT}`));
