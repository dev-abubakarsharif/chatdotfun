import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import bs58 from "bs58";
import {
  Keypair,
  Connection,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio client (Render handles credentials)
const client = twilio();

// Solana Devnet connection
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// In-memory storage
const users = {};
const tokens = {};

// Helper: Main Menu
function mainMenu() {
  return (
    "🚀 *Welcome to Chat.fun (Solana Devnet)*\n\n" +
    "Choose an option:\n" +
    "1️⃣ Launch Token\n" +
    "2️⃣ Buy Token\n" +
    "3️⃣ Send Token\n" +
    "4️⃣ My Portfolio\n\n" +
    "Reply with a number."
  );
}

// === WALLET IMPORT ===
async function importWallet(from, keyStr) {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(keyStr.trim()));
    const balance = await connection.getBalance(keypair.publicKey);
    const sol = (balance / 1e9).toFixed(3);

    users[from] = { wallet: keypair, state: "main", tokens: {}, temp: {} };
    return (
      `✅ Wallet connected successfully!\n💰 Balance: ${sol} SOL (Devnet)\n` +
      `📍 Address: ${keypair.publicKey.toBase58()}\n\n` +
      mainMenu()
    );
  } catch (e) {
    console.error("Wallet import failed:", e);
    return (
      "❌ Invalid private key format.\n\nMake sure it looks like this:\n" +
      `"t2xbg6kkB812NHPPWcUE3HyQwwEsiKGHgLiQ8jLodQwuYjQ8iHz7wfmGjzNkCZDnB21GmBgUkmggs11PwQGc3H1"`
    );
  }
}

// === LAUNCH TOKEN ===
async function launchToken(from) {
  const user = users[from];
  const { name, symbol, supply, decimals, story, link, liquidity } = user.temp;
  const wallet = user.wallet;

  try {
    const mint = await createMint(connection, wallet, wallet.publicKey, null, parseInt(decimals));
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
      wallet.publicKey,
      BigInt(supply)
    );

    const mintAddr = mint.toBase58();
    tokens[name.toLowerCase()] = {
      mint: mintAddr,
      symbol,
      supply,
      story,
      link,
      liquidity,
      owner: from,
    };

    user.tokens[name] = mintAddr;
    user.state = "main";

    return (
      `✅ *${name} ($${symbol}) is LIVE on Devnet!*\n\n` +
      `📖 Story: ${story}\n🌐 ${link}\n💧 Liquidity: ${liquidity} SOL\n\n` +
      `🪙 Mint Address: ${mintAddr}\n🔗 Explorer: https://explorer.solana.com/address/${mintAddr}?cluster=devnet\n\n` +
      `🔥 Base Price: 0.000001 SOL (simulated)\n\n` +
      mainMenu()
    );
  } catch (e) {
    console.error("Token launch error:", e);
    return "❌ Token launch failed. Check your SOL balance or inputs.";
  }
}

// === SEND TOKEN ===
async function sendToken(from, body) {
  const user = users[from];
  const wallet = user.wallet;
  const parts = body.split(" ");
  if (parts.length < 3)
    return "⚠️ Format: send <mint> <receiver_wallet> <amount>";

  const mintAddr = new PublicKey(parts[0]);
  const receiver = new PublicKey(parts[1]);
  const amount = BigInt(parts[2]);

  try {
    const sourceATA = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mintAddr,
      wallet.publicKey
    );
    const destATA = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mintAddr,
      receiver
    );

    const sig = await transfer(
      connection,
      wallet,
      sourceATA.address,
      destATA.address,
      wallet.publicKey,
      amount
    );

    return (
      `✅ Sent ${amount} tokens!\n\n` +
      `🪙 Mint: ${mintAddr}\n📤 Tx: ${sig}\n` +
      `🔗 https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  } catch (e) {
    console.error("Send failed:", e);
    return "❌ Token transfer failed. Make sure you own this token.";
  }
}

// === MESSAGE HANDLER ===
async function handleMessage(from, msg) {
  const body = msg.trim();
  const text = body.toLowerCase();
  const user = users[from] || {};

  // === Onboarding ===
  if (text === "hi" || text === "hello" || text === "/start") {
    if (!user.wallet)
      return (
        "🚀 Welcome to Chat.fun, the wildest way to launch tokens on Solana.\n\n" +
        "⚠️ Before we start, connect your wallet.\nPaste your private key (base58) 👇"
      );
    return mainMenu();
  }

  // === If user pastes a base58 private key ===
  if (!user.wallet && body.length >= 80 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(body))
    return await importWallet(from, body);

  if (!user.wallet)
    return "⚠️ Please paste your Solana private key first to continue.";

  // === Main Menu ===
  if (user.state === "main") {
    switch (text) {
      case "1":
      case "/launch":
        user.state = "launch_name";
        return "🔥 Let’s drop your token! Enter token name:";
      case "2":
        return "💸 Buy feature (Devnet simulation) coming soon!";
      case "3":
        return (
          "✉️ Send SPL tokens on Devnet.\nFormat:\n" +
          "`send <mint_address> <receiver_wallet> <amount>`"
        );
      case "4": {
        const lamports = await connection.getBalance(user.wallet.publicKey);
        const sol = (lamports / 1e9).toFixed(3);
        const tokenList =
          Object.entries(user.tokens || {})
            .map(([name, addr]) => `• ${name}: ${addr}`)
            .join("\n") || "No tokens yet.";
        return `👛 Wallet: ${user.wallet.publicKey.toBase58()}\n💰 Balance: ${sol} SOL\n\n${tokenList}\n\n${mainMenu()}`;
      }
      default:
        if (text.startsWith("send")) return await sendToken(from, body.replace("send ", ""));
        return "❓ Invalid option. Type 'hi' to restart.";
    }
  }

  // === Launch Flow ===
  if (user.state === "launch_name") {
    user.temp = { name: body };
    user.state = "launch_symbol";
    return "💲 Enter token symbol (e.g. SWF):";
  }
  if (user.state === "launch_symbol") {
    user.temp.symbol = body.toUpperCase();
    user.state = "launch_supply";
    return "💰 Enter total supply (e.g. 1000000000):";
  }
  if (user.state === "launch_supply") {
    user.temp.supply = body;
    user.state = "launch_decimals";
    return "🔢 Enter decimals (usually 9):";
  }
  if (user.state === "launch_decimals") {
    user.temp.decimals = body;
    user.state = "launch_story";
    return "📖 Describe your token’s story or purpose:";
  }
  if (user.state === "launch_story") {
    user.temp.story = body;
    user.state = "launch_link";
    return "🔗 Enter your community link (Telegram, Twitter, etc.):";
  }
  if (user.state === "launch_link") {
    user.temp.link = body;
    user.state = "launch_liquidity";
    return "💧 Enter initial liquidity in SOL (e.g., 0.5):";
  }
  if (user.state === "launch_liquidity") {
    user.temp.liquidity = body;
    user.state = "launch_confirm";
    const t = user.temp;
    return (
      `🧠 Confirm Launch Details:\n\n` +
      `Name: ${t.name}\nSymbol: $${t.symbol}\nSupply: ${t.supply}\nDecimals: ${t.decimals}\n` +
      `Liquidity: ${t.liquidity} SOL\nStory: ${t.story}\nLink: ${t.link}\n\n` +
      `Type *confirm* to launch or *cancel* to abort.`
    );
  }
  if (user.state === "launch_confirm") {
    if (text === "confirm") return await launchToken(from);
    if (text === "cancel") {
      user.state = "main";
      return "❌ Launch cancelled.\n\n" + mainMenu();
    }
  }

  if (text.startsWith("send")) return await sendToken(from, body.replace("send ", ""));

  return "Type 'hi' to start again.";
}

// === TWILIO WEBHOOK ===
app.use(bodyParser.urlencoded({ extended: false }));
app.post("/incoming", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  const reply = await handleMessage(from, body);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// === SERVER ===
app.get("/", (req, res) => res.send("🚀 Chat.fun Devnet bot running (index.js)!"));
app.listen(PORT, () => console.log(`✅ Bot live on port ${PORT} (Devnet)`));
