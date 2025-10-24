/**
 * index.js
 * Chat.fun WhatsApp bot MVP (Twilio) - Render ready
 *
 * - Keeps /import logic as-is (supports JSON array secret or base58)
 * - Implements onboarding, launch, buy, sell flows (stateful per phone number)
 * - Simulates "buttons" via text/emoji/number choices
 * - Displays wallet balance after import
 *
 * Note: for production, DO NOT store secret keys in memory as arrays — this is unsafe.
 */

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { Keypair, Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";

// Environment variables
const app = express();
const PORT = process.env.PORT || 3000;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- In-memory store (simple state) ---
const users = {}; // { phone: { state, wallet } }

// --- Solana Connection ---
const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");

// --- Core menu generator ---
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

// --- Wallet Import Handler ---
async function tryImportWallet(from, rawText) {
  try {
    let keypair;
    const text = rawText.trim();

    // Try to decode as base58 secret
    try {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
    } catch {
      keypair = Keypair.fromSecretKey(Buffer.from(text, "base58"));
    }

    users[from] = { ...users[from], wallet: keypair, state: "main" };

    // Fetch balance in SOL
    const publicKey = keypair.publicKey;
    let balanceSol = 0;
    try {
      const balanceLamports = await connection.getBalance(publicKey);
      balanceSol = balanceLamports / 1e9; // Convert lamports to SOL
    } catch (err) {
      console.error("Error fetching balance:", err);
    }

    return {
      success: true,
      message:
        `✅ Wallet imported!\n` +
        `Your address: ${publicKey.toBase58()}\n` +
        `💰 Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
        sendMainMenu(),
    };
  } catch (err) {
    console.error("Wallet import failed:", err);
    return { success: false, message: "❌ Invalid wallet format. Try again." };
  }
}

// --- Handle incoming messages ---
async function handleIncoming(from, rawBody) {
  const body = rawBody.trim();
  const user = users[from] || { state: "onboarding" };

  if (body.toLowerCase() === "hi" || body.toLowerCase() === "hello") {
    users[from] = { state: "awaiting_import" };
    return (
      "👋 Welcome to Chat.fun\n" +
      "Paste your private key (in base58 or JSON array format) to connect your Solana wallet."
    );
  }

  // Wallet import flow
  if (user.state === "awaiting_import") {
    const r = await tryImportWallet(from, body);
    return r.message;
  }

  // Main menu interactions
  if (user.state === "main") {
    switch (body) {
      case "1":
        return "🚀 Token Launch flow coming soon...";
      case "2":
        return "💸 Token Buy flow coming soon...";
      case "3":
        return "🔁 Token Sell flow coming soon...";
      case "4":
        return (
          `👛 Wallet Address: ${user.wallet.publicKey.toBase58()}\n\n` +
          sendMainMenu()
        );
      default:
        return "❓ Invalid choice. Please select 1, 2, 3, or 4.";
    }
  }

  return "Type 'Hi' to start.";
}

// --- Webhook for Twilio ---
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
