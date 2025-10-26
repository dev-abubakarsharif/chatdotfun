import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import bs58 from "bs58";
import {
  Keypair,
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio setup
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "whatsapp:+14155238886";
const client = twilio();

// Solana Devnet
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// In-memory users + tokens
const users = {}; // { phone: { state, wallet, tempName, tempSymbol, tempStory, lastToken } }
const tokens = {}; // { name: { mintAddress, symbol, story, owner } }

function sendMainMenu() {
  return (
    "🔥 Welcome to Chat.fun (Solana Devnet)\n\n" +
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

    const lamports = await connection.getBalance(keypair.publicKey);
    const balanceSol = lamports / 1e9;

    return (
      `✅ Wallet imported successfully on *Solana Devnet!*\n` +
      `📍 Address: ${keypair.publicKey.toBase58()}\n` +
      `💰 Balance: ${balanceSol.toFixed(4)} SOL\n\n` +
      sendMainMenu()
    );
  } catch (err) {
    console.error("Wallet import failed:", err);
    return "❌ Invalid wallet format. Please paste a valid Solana private key.";
  }
}

async function launchToken(from) {
  const user = users[from];
  if (!user?.wallet) return "⚠️ Please import your wallet first by typing 'hi'.";

  const { wallet, tempName, tempSymbol, tempStory } = user;

  try {
    const mint = await createMint(connection, wallet, wallet.publicKey, null, 9);
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
      1_000_000_000n // 1 billion supply
    );

    const mintAddress = mint.toBase58();
    tokens[tempName.toLowerCase()] = {
      mintAddress,
      symbol: tempSymbol,
      story: tempStory,
      owner: from,
    };

    users[from].lastToken = mintAddress;
    users[from].state = "main";

    // 🔗 OPTIONAL: Trigger your n8n webhook for announcements
    // await fetch("https://your-n8n-url/webhook/announce", {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify({
    //     name: tempName,
    //     symbol: tempSymbol,
    //     story: tempStory,
    //     mintAddress,
    //   }),
    // });

    return (
      `🚀 *${tempName} ($${tempSymbol}) launched successfully!*\n\n` +
      `📖 Story: ${tempStory}\n\n` +
      `🪙 Mint Address: ${mintAddress}\n` +
      `🌐 Explorer: https://explorer.solana.com/address/${mintAddress}?cluster=devnet\n\n` +
      sendMainMenu()
    );
  } catch (err) {
    console.error("Token launch failed:", err);
    return "❌ Token launch failed. Please check your Devnet SOL and try again.";
  }
}

async function handleIncoming(from, rawBody) {
  const body = rawBody.trim();
  const user = users[from] || { state: "onboarding" };

  if (body.toLowerCase() === "hi" || body.toLowerCase() === "hello") {
    users[from] = { state: "awaiting_import" };
    return (
      "👋 Welcome to Chat.fun (Solana Devnet Mode)\n" +
      "Paste your Solana private key to import wallet.\n\n" +
      "💧 Get free SOL: https://faucet.solana.com/"
    );
  }

  if (user.state === "awaiting_import") return await tryImportWallet(from, body);

  if (user.state === "main") {
    switch (body) {
      case "1":
        users[from].state = "launch_token_name";
        return "🚀 Enter your token name (e.g., SwiftFee):";
      case "2":
        users[from].state = "buy_token_query";
        return "💸 Enter token name or address to buy:";
      case "3":
        return "🔁 Sell Token feature coming soon!";
      case "4": {
        const wallet = user.wallet;
        const lamports = await connection.getBalance(wallet.publicKey);
        const balanceSol = lamports / 1e9;
        return (
          `👛 Wallet Address: ${wallet.publicKey.toBase58()}\n` +
          `💰 Balance: ${balanceSol.toFixed(4)} SOL (Devnet)\n\n` +
          sendMainMenu()
        );
      }
      default:
        return "❓ Invalid option. Please reply with 1, 2, 3, or 4.";
    }
  }

  if (user.state === "launch_token_name") {
    users[from].tempName = body;
    users[from].state = "launch_token_symbol";
    return "💲 Enter token symbol (e.g., SWF):";
  }

  if (user.state === "launch_token_symbol") {
    users[from].tempSymbol = body.toUpperCase();
    users[from].state = "launch_token_story";
    return "📝 Enter a short story or description about your token:";
  }

  if (user.state === "launch_token_story") {
    users[from].tempStory = body;
    users[from].state = "launching";
    return await launchToken(from);
  }

  if (user.state === "buy_token_query") {
    const query = body.toLowerCase();
    const token =
      tokens[query] ||
      Object.values(tokens).find((t) => t.mintAddress === body);
    if (!token) {
      users[from].state = "main";
      return "❌ Token not found. Try again.";
    }
    users[from].state = "main";
    return (
      `💸 You bought 10 ${token.symbol} successfully (simulated)\n` +
      `🪙 Mint: ${token.mintAddress}\n\n` +
      sendMainMenu()
    );
  }

  return "Type 'hi' to begin.";
}

// --- Twilio webhook ---
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

app.get("/", (req, res) => {
  res.send("🚀 Chat.fun Devnet bot running successfully!");
});

app.listen(PORT, () =>
  console.log(`🚀 Chat.fun bot is live on port ${PORT} (Devnet Mode)`)
);
