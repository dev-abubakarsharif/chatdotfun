// index.js
import express from "express";
import bodyParser from "body-parser";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import bs58 from "bs58";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

// ------------------- TWILIO SETUP -------------------
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = "whatsapp:+14155238886"; // Twilio sandbox number

// ------------------- SOLANA SETUP -------------------
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// ------------------- EXPRESS SETUP -------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Temporary in-memory session (no DB)
const sessions = {};

// Helper: Send WhatsApp message
async function sendMessage(to, body) {
  try {
    await client.messages.create({ from: TWILIO_NUMBER, to, body });
  } catch (error) {
    console.error("Twilio send error:", error.message);
  }
}

// ------------------- MAIN BOT LOGIC -------------------
app.post("/incomin", async (req, res) => {
  const from = req.body.From;
  const msg = req.body.Body?.trim();
  let user = sessions[from] || { stage: "start" };

  try {
    // ✅ Quick test for connection
    if (msg.toLowerCase() === "hi") {
      await sendMessage(from, "👋 Hello! Chat.fun bot is online and ready on Devnet!");
      return res.status(200).end();
    }

    switch (user.stage) {
      case "start":
        await sendMessage(
          from,
          `🚀 Welcome to Chat.fun!\nLaunch and send tokens on Solana Devnet.\n\nPlease enter your private key (base58):`
        );
        user.stage = "awaiting_wallet";
        break;

      case "awaiting_wallet":
        try {
          const secretKey = bs58.decode(msg);
          const keypair = Keypair.fromSecretKey(secretKey);
          const balance = await connection.getBalance(keypair.publicKey);

          user.wallet = keypair;
          user.stage = "main_menu";

          await sendMessage(
            from,
            `✅ Wallet connected!\n💰 Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL\n\nCommands:\n/launch — Launch a new token\n/send — Send SPL tokens`
          );
        } catch {
          await sendMessage(from, "❌ Invalid key. Please enter a valid base58 private key.");
        }
        break;

      // ------------------- TOKEN LAUNCH -------------------
      case "launch_name":
        user.token.name = msg;
        user.stage = "launch_symbol";
        await sendMessage(from, "Enter your token symbol (e.g., SWF):");
        break;

      case "launch_symbol":
        user.token.symbol = msg;
        user.stage = "launch_story";
        await sendMessage(from, "Describe your token's story:");
        break;

      case "launch_story":
        user.token.story = msg;
        user.stage = "launch_supply";
        await sendMessage(from, "Enter total supply (e.g., 1000000):");
        break;

      case "launch_supply":
        user.token.supply = parseInt(msg);
        user.stage = "launch_decimals";
        await sendMessage(from, "Enter decimals (usually 9):");
        break;

      case "launch_decimals":
        user.token.decimals = parseInt(msg);
        user.stage = "launch_confirm";
        const t = user.token;
        await sendMessage(
          from,
          `⚙️ Confirm token details:\nName: ${t.name}\nSymbol: ${t.symbol}\nStory: ${t.story}\nSupply: ${t.supply}\nDecimals: ${t.decimals}\n\nType "confirm" or "cancel".`
        );
        break;

      default:
        // ------------------- MAIN MENU COMMANDS -------------------
        if (msg.toLowerCase() === "/launch" && user.stage === "main_menu") {
          user.stage = "launch_name";
          user.token = {};
          await sendMessage(from, "Let's launch your token!\nEnter token name:");
        }

        else if (msg.toLowerCase() === "confirm" && user.stage === "launch_confirm") {
          const kp = user.wallet;
          const t = user.token;

          const mint = await createMint(connection, kp, kp.publicKey, null, t.decimals);
          const ata = await getOrCreateAssociatedTokenAccount(connection, kp, mint, kp.publicKey);
          const amount = BigInt(t.supply) * BigInt(10 ** t.decimals);

          await mintTo(connection, kp, mint, ata.address, kp, Number(amount));

          await sendMessage(
            from,
            `✅ Token Created!\n${t.name} ($${t.symbol})\nMint: ${mint.toBase58()}\n🔗 View:\nhttps://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`
          );
          user.stage = "main_menu";
        }

        else if (msg.toLowerCase() === "cancel" && user.stage === "launch_confirm") {
          user.stage = "main_menu";
          await sendMessage(from, "❌ Token launch cancelled.");
        }

        // ------------------- SEND TOKEN -------------------
        else if (msg.toLowerCase() === "/send" && user.stage === "main_menu") {
          user.stage = "awaiting_send_mint";
          await sendMessage(from, "Enter token mint address:");
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
          const amount = Number(msg);

          const fromAta = await getOrCreateAssociatedTokenAccount(
            connection,
            user.wallet,
            mintPubkey,
            user.wallet.publicKey
          );
          const toAta = await getOrCreateAssociatedTokenAccount(
            connection,
            user.wallet,
            mintPubkey,
            receiverPubkey
          );

          await transfer(connection, user.wallet, fromAta.address, toAta.address, user.wallet, amount);
          user.stage = "main_menu";

          await sendMessage(from, `✅ Sent ${amount} tokens to ${receiverPubkey.toBase58()} on Devnet.`);
        }

        else {
          await sendMessage(from, "❓ Unknown command. Use /launch or /send.");
        }
    }

    sessions[from] = user;
    res.status(200).end();
  } catch (err) {
    console.error("❌ Error:", err);
    await sendMessage(from, "⚠️ An error occurred. Please try again later.");
    res.status(500).end();
  }
});

// ------------------- SERVER -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Chat.fun bot running on port ${PORT} (Devnet)`));
