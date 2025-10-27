// index.js
import express from "express";
import bodyParser from "body-parser";
import { Connection, Keypair, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer } from "@solana/spl-token";
import bs58 from "bs58";
import twilio from "twilio";

// Twilio setup (no .env)
const client = twilio("ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "your_auth_token"); // Replace with yours
const TWILIO_NUMBER = "whatsapp:+14155238886";

// Solana setup
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// Express setup
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Session store
const sessions = {};

// Helper to send WhatsApp messages
async function sendMessage(to, body) {
  await client.messages.create({ from: TWILIO_NUMBER, to, body });
}

// WhatsApp bot handler
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const msg = req.body.Body.trim();
  const user = sessions[from] || { stage: "start" };

  try {
    // 🧩 Step 1: Onboarding
    if (user.stage === "start") {
      await sendMessage(
        from,
        `🚀 Welcome to Chat.fun, the wildest way to launch and trade tokens on Solana!\n\n⚠️ Before we start, connect your wallet.\nEnter your private key below 👇`
      );
      user.stage = "awaiting_wallet";
    }

    // 🧩 Step 2: Connect wallet
    else if (user.stage === "awaiting_wallet") {
      try {
        const secretKey = bs58.decode(msg);
        const keypair = Keypair.fromSecretKey(secretKey);
        const balance = await connection.getBalance(keypair.publicKey);
        const sol = (balance / LAMPORTS_PER_SOL).toFixed(2);

        user.wallet = keypair;
        user.stage = "main_menu";

        await sendMessage(
          from,
          `✅ Wallet connected successfully!\nBalance: ${sol} SOL\n\nYou’re ready to cook, anon 🔥\n\nCommands:\n/launch — Launch Token\n/buy — Buy Token\n/send — Send SPL Tokens`
        );
      } catch (err) {
        await sendMessage(from, "❌ Invalid key format. Please paste a valid base58 private key.");
      }
    }

    // 🧩 Step 3: Token Launch Flow
    else if (msg.toLowerCase() === "/launch" && user.stage === "main_menu") {
      user.stage = "launch_name";
      await sendMessage(from, "Let’s drop some heat 🔥\nEnter your token name:");
    } else if (user.stage === "launch_name") {
      user.token = { name: msg };
      user.stage = "launch_symbol";
      await sendMessage(from, "Enter your token symbol (e.g. SWF):");
    } else if (user.stage === "launch_symbol") {
      user.token.symbol = msg;
      user.stage = "launch_story";
      await sendMessage(from, "Describe your token’s story or purpose:");
    } else if (user.stage === "launch_story") {
      user.token.story = msg;
      user.stage = "launch_supply";
      await sendMessage(from, "Enter total supply (e.g. 1000000000):");
    } else if (user.stage === "launch_supply") {
      user.token.supply = parseInt(msg);
      user.stage = "launch_decimals";
      await sendMessage(from, "Enter decimals (usually 9):");
    } else if (user.stage === "launch_decimals") {
      user.token.decimals = parseInt(msg);
      user.stage = "launch_confirm";
      const t = user.token;
      await sendMessage(
        from,
        `🧠 Confirm launch:\n\nName: ${t.name}\nSymbol: ${t.symbol}\nStory: ${t.story}\nSupply: ${t.supply}\nDecimals: ${t.decimals}\n\nType "confirm" to deploy or "cancel" to stop.`
      );
    } else if (msg.toLowerCase() === "confirm" && user.stage === "launch_confirm") {
      const kp = user.wallet;
      const mint = await createMint(connection, kp, kp.publicKey, null, user.token.decimals);
      const ata = await getOrCreateAssociatedTokenAccount(connection, kp, mint, kp.publicKey);
      await mintTo(connection, kp, mint, ata.address, kp, user.token.supply * 10 ** user.token.decimals);

      await sendMessage(
        from,
        `✅ Token *${user.token.name}* ($${user.token.symbol}) is LIVE on Devnet!\nMint Address: ${mint.toBase58()}\nExplorer: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`
      );
      user.stage = "main_menu";
    } else if (msg.toLowerCase() === "cancel" && user.stage === "launch_confirm") {
      await sendMessage(from, "❌ Launch cancelled. No SOL deducted. No token created.");
      user.stage = "main_menu";
    }

    // 🧩 Step 4: Send Tokens
    else if (msg.toLowerCase() === "/send" && user.stage === "main_menu") {
      user.stage = "awaiting_send_mint";
      await sendMessage(from, "Enter the token mint address to send:");
    } else if (user.stage === "awaiting_send_mint") {
      user.transfer = { mint: msg };
      user.stage = "awaiting_send_receiver";
      await sendMessage(from, "Enter receiver wallet address:");
    } else if (user.stage === "awaiting_send_receiver") {
      user.transfer.receiver = msg;
      user.stage = "awaiting_send_amount";
      await sendMessage(from, "Enter amount to send:");
    } else if (user.stage === "awaiting_send_amount") {
      const mintPubkey = new PublicKey(user.transfer.mint);
      const receiverPubkey = new PublicKey(user.transfer.receiver);
      const amount = parseInt(msg);

      const fromAta = await getOrCreateAssociatedTokenAccount(
        connection,
        user.wallet,
        mintPubkey,
        user.wallet.publicKey
      );
      const toAta = await getOrCreateAssociatedTokenAccount(connection, user.wallet, mintPubkey, receiverPubkey);

      await transfer(connection, user.wallet, fromAta.address, toAta.address, user.wallet, amount);

      await sendMessage(from, `✅ Sent ${amount} tokens to ${receiverPubkey.toBase58()} successfully on Devnet.`);
      user.stage = "main_menu";
    }

    sessions[from] = user;
    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err);
    res.sendStatus(500);
  }
});

// Server start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
