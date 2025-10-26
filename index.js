/**
 * index.js
 * Chat.fun WhatsApp/Render bot - Devnet version (No Twilio SID)
 *
 * ✅ Imports Solana wallet (JSON array or base58)
 * ✅ Shows wallet balance after import
 * ✅ Launches token on Devnet
 * ✅ Buys token by name or address (simulation)
 */

import express from "express";
import bodyParser from "body-parser";
import bs58 from "bs58";
import { Keypair, Connection, clusterApiUrl } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

// --- Setup Express ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- In-memory user & token store ---
const users = {}; // { phone: { state, wallet, lastToken } }
const tokens = {}; // { name: { mintAddress, symbol, owner } }

// --- Solana Devnet connection ---
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// --- Menus ---
function sendMainMenu() {
  return (
    "🔥 You’re ready to cook on Devnet 🔥\n\n" +
    "1️⃣ Launch Token\n" +
    "2️⃣ Buy Token\n" +
    "3️⃣ Sell Token\n" +
    "4️⃣ My Wallet\n\n" +
    "Reply with a number:"
  );
}

// --- Wallet Import ---
async function tryImportWallet(from, rawText) {
  try {
    let keypair;
    const text = rawText.trim();

    // JSON array or base58 secret
    try {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
    } catch {
      keypair = Keypair.fromSecretKey(bs58.decode(text));
    }

    users[from] = { ...users[from], wallet: keypair, state: "main" };

    const lamports = await connection.getBalance(keypair.publicKey);
    const balanceSol = lamports / 1e9;

    return (
      `✅ Wallet imported successfully!\n` +
      `📍 Address: ${keypair.publicKey.toBase58()}\n` +
      `💰 Balance: ${balanceSol.toFixed(4)} SOL (Devnet)\n\n` +
      sendMainMenu()
    );
  } catch (err) {
    console.error("Wallet import failed:", err);
    return "❌ Invalid wallet format. Please paste a valid Solana private key.";
  }
}

// --- Token Launch ---
async function launchToken(from, name = "TestCoin", symbol = "TST") {
  const user = users[from];
  if (!user || !user.wallet)
    return "⚠️ Please import your wallet first by typing 'Hi'.";

  const wallet = user.wallet;

  try {
    const mint = await createMint(connection, wallet, wallet.publicKey, null, 9);
    const mintAddress = mint.toBase58();

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mint,
      wallet.publicKey
    );

    await mintTo(
      connection,
      wallet,
      mint,
      tokenAccount.address,
      wallet.publicKey,
      1_000_000_000n // total supply (example)
    );

    tokens[name.toLowerCase()] = { mintAddress, symbol, owner: from };
    users[from].lastToken = mintAddress;

    return (
      `🚀 Token launched successfully on Devnet!\n\n` +
      `🪙 Name: ${name}\n` +
      `💲 Symbol: ${symbol}\n` +
      `📍 Address: ${mintAddress}\n` +
      `🔗 Explorer: https://explorer.solana.com/address/${mintAddress}?cluster=devnet\n\n` +
      sendMainMenu()
    );
  } catch (err) {
    console.error("Token launch failed:", err);
    return "❌ Token launch failed. Check logs for details.";
  }
}

// --- Simulated Buy ---
async function buyToken(from, query) {
  if (!users[from] || !users[from].wallet)
    return "⚠️ Import wallet first by typing 'Hi'.";

  const token =
    tokens[query.toLowerCase()] ||
    Object.values(tokens).find((t) => t.mintAddress === query);

  if (!token)
    return "❌ Token not found. Try again with token name or address.";

  return (
    `💸 You bought 10 ${token.symbol} (${query}) successfully (simulation)\n` +
    `🪙 Token Address: ${token.mintAddress}\n\n` +
    sendMainMenu()
  );
}

// --- Handle Incoming ---
async function handleIncoming(from, rawBody) {
  const body = rawBody.trim();
  const user = users[from] || { state: "onboarding" };

  if (body.toLowerCase() === "hi" || body.toLowerCase() === "hello") {
    users[from] = { state: "awaiting_import" };
    return (
      "👋 Welcome to Chat.fun (Devnet mode)\n" +
      "Paste your Solana private key to connect your wallet.\n\n" +
      "💡 Use a Devnet wallet and get free SOL from https://faucet.solana.com"
    );
  }

  if (user.state === "awaiting_import") {
    return await tryImportWallet(from, body);
  }

  if (user.state === "main") {
    switch (body) {
      case "1":
        users[from].state = "launch_token_name";
        return "🚀 Enter token name:";
      case "2":
        users[from].state = "buy_token_query";
        return "💸 Enter token name or address to buy:";
      case "3":
        return "🔁 Sell Token coming soon...";
      case "4": {
        const wallet = user.wallet;
        const lamports = await connection.getBalance(wallet.publicKey);
        const balanceSol = lamports / 1e9;
        return (
          `👛 Wallet Address: ${wallet.publicKey.toBase58()}\n` +
          `💰 Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
          sendMainMenu()
        );
      }
      default:
        return "❓ Invalid choice. Select 1, 2, 3, or 4.";
    }
  }

  if (user.state === "launch_token_name") {
    users[from].tempName = body;
    users[from].state = "launch_token_symbol";
    return "Enter token symbol (e.g. TST):";
  }

  if (user.state === "launch_token_symbol") {
    const name = user.tempName;
    const symbol = body;
    users[from].state = "main";
    return await launchToken(from, name, symbol);
  }

  if (user.state === "buy_token_query") {
    users[from].state = "main";
    return await buyToken(from, body);
  }

  return "Type 'Hi' to start.";
}

// --- POST endpoint (for Render or frontend test) ---
app.post("/incoming", async (req, res) => {
  const from = req.body.from || "guest";
  const body = req.body.body || "";

  const reply = await handleIncoming(from, body);
  res.json({ reply });
});

// --- GET for testing on browser ---
app.get("/", (req, res) => {
  res.send("🚀 Chat.fun Devnet bot running successfully!");
});

// --- Start Server ---
app.listen(PORT, () =>
  console.log(`🚀 Chat.fun Devnet bot live on port ${PORT}`)
);
