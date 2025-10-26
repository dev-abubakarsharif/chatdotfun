import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import bs58 from "bs58";
import {
  Keypair,
  Connection,
  clusterApiUrl,
  PublicKey,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio Setup — you don’t need to set SID manually if Render handles webhook
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "whatsapp:+14155238886";
const client = twilio();

// Solana Devnet connection
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// In-memory user data
const users = {}; // { phone: { state, wallet } }

function sendMainMenu() {
  return (
    "🔥 Welcome back, anon!\n\n" +
    "1️⃣ Launch Token\n" +
    "2️⃣ Buy Token\n" +
    "3️⃣ Sell Token\n" +
    "4️⃣ My Wallet\n\n" +
    "Reply with a number:"
  );
}

async function tryImportWallet(from, rawText) {
  try {
    let keypair;
    const text = rawText.trim();

    try {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
    } catch {
      keypair = Keypair.fromSecretKey(bs58.decode(text));
    }

    users[from] = { ...users[from], wallet: keypair, state: "main" };

    const publicKey = keypair.publicKey;
    const lamports = await connection.getBalance(publicKey);
    const balanceSol = lamports / 1e9;

    return {
      success: true,
      message:
        `✅ Wallet imported successfully on *Solana Devnet*!\n` +
        `📍 Address: ${publicKey.toBase58()}\n` +
        `💰 Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
        sendMainMenu(),
    };
  } catch (err) {
    console.error("Wallet import failed:", err);
    return { success: false, message: "❌ Invalid wallet format. Try again." };
  }
}

async function handleIncoming(from, body) {
  const text = body.trim();
  const user = users[from] || { state: "onboarding" };

  if (text.toLowerCase() === "hi" || text.toLowerCase() === "hello") {
    users[from] = { state: "awaiting_import" };
    return "👋 Welcome to Chat.fun!\nPaste your *Solana private key* to connect your wallet (Devnet).";
  }

  if (user.state === "awaiting_import") {
    const r = await tryImportWallet(from, text);
    return r.message;
  }

  if (user.state === "main") {
    switch (text) {
      case "1": {
        const wallet = user.wallet;
        if (!wallet)
          return "⚠️ No wallet found. Please import again with 'hi'.";

        try {
          const lamports = await connection.getBalance(wallet.publicKey);
          const balanceSol = lamports / 1e9;

          if (balanceSol < 0.01)
            return (
              `⚠️ Not enough Devnet SOL.\n` +
              `💧 Get free SOL here: https://faucet.solana.com/\n` +
              `Your Address: ${wallet.publicKey.toBase58()}`
            );

          // Launch Token
          const mint = await createMint(
            connection,
            wallet,
            wallet.publicKey,
            null,
            9
          );

          const ata = await getOrCreateAssociatedTokenAccount(
            connection,
            wallet,
            mint,
            wallet.publicKey
          );

          await mintTo(
            connection,
            wallet,
            mint,
            ata.address,
            wallet,
            1_000_000_000_000n // 1 trillion tokens
          );

          return (
            `🚀 *Token Launched Successfully!*\n\n` +
            `🪙 Mint Address:\n${mint.toBase58()}\n\n` +
            `🌐 View on Explorer:\nhttps://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet\n\n` +
            `👛 Wallet Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
            sendMainMenu()
          );
        } catch (err) {
          console.error("Launch failed:", err);
          return "❌ Token launch failed. Please try again later.";
        }
      }

      case "2":
        return "💸 Coming soon: Buy token by name or address.";

      case "3":
        return "🔁 Sell flow coming soon.";

      case "4": {
        const wallet = user.wallet;
        if (!wallet) return "⚠️ No wallet found. Please import again.";
        const lamports = await connection.getBalance(wallet.publicKey);
        const balanceSol = lamports / 1e9;
        return (
          `👛 Wallet Address: ${wallet.publicKey.toBase58()}\n` +
          `💰 Balance: ${balanceSol.toFixed(4)} SOL (Devnet)\n\n` +
          sendMainMenu()
        );
      }

      default:
        return "❓ Invalid choice. Please reply with 1, 2, 3, or 4.";
    }
  }

  return "Type 'Hi' to start.";
}

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/incoming", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  const reply = await handleIncoming(from, body);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

app.listen(PORT, () =>
  console.log(`🚀 Chat.fun bot running on port ${PORT} (Devnet Mode)`)
);
