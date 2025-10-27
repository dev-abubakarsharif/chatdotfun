/**
 * Solana Token Launch WhatsApp Bot (Devnet)
 * Flow:
 * User: "launch token"
 * Bot asks: name → symbol → story → supply → decimals → freeze authority → confirmation → deploys
 */

import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// =========================
// 🔹 Inline Configuration
// =========================
const PORT = 3000;
const TWILIO_ACCOUNT_SID = "your_twilio_account_sid_here";
const TWILIO_AUTH_TOKEN = "your_twilio_auth_token_here";
const TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155238886"; // Twilio sandbox

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const payer = Keypair.generate(); // Devnet wallet

const sessions = new Map(); // session per user

// =========================
// 🔹 Webhook Endpoint
// =========================
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body.trim();
  let session = sessions.get(from);

  if (!session) {
    session = { step: 0, data: {} };
    sessions.set(from, session);
  }

  let reply = "";

  try {
    if (body.toLowerCase() === "launch token" && session.step === 0) {
      reply = "🚀 Let's launch your token on *Solana Devnet*.\n\nEnter token name:";
      session.step = 1;
    } else {
      switch (session.step) {
        case 1:
          session.data.name = body;
          reply = "Enter symbol (e.g. SWF):";
          session.step = 2;
          break;

        case 2:
          session.data.symbol = body;
          reply = "Describe your token’s story or purpose:";
          session.step = 3;
          break;

        case 3:
          session.data.story = body;
          reply = "Enter total supply (e.g. 1000000000):";
          session.step = 4;
          break;

        case 4:
          if (isNaN(parseInt(body)) || parseInt(body) <= 0) {
            reply = "❌ Invalid number. Enter a valid total supply (e.g. 1000000000):";
            break;
          }
          session.data.supply = parseInt(body);
          reply = "Enter decimals (usually 9):";
          session.step = 5;
          break;

        case 5:
          if (isNaN(parseInt(body))) {
            reply = "❌ Invalid input. Enter decimals (usually 9):";
            break;
          }
          session.data.decimals = parseInt(body);
          reply = "Set a freeze authority? (yes/no)";
          session.step = 6;
          break;

        case 6:
          session.data.freezeAuthority = body.toLowerCase() === "yes";
          reply =
            "✅ Confirm launch with the following details:\n\n" +
            `🏷️ Name: ${session.data.name}\n` +
            `💠 Symbol: ${session.data.symbol}\n` +
            `📖 Story: ${session.data.story}\n` +
            `💰 Supply: ${session.data.supply}\n` +
            `🔢 Decimals: ${session.data.decimals}\n` +
            `❄️ Freeze Authority: ${session.data.freezeAuthority ? "Yes" : "No"}\n\n` +
            "Type *confirm* to deploy or *cancel* to stop.";
          session.step = 7;
          break;

        case 7:
          if (body.toLowerCase() === "confirm") {
            reply = "🚀 Launching your token on Solana Devnet...";
            session.step = 8;
            await sendWhatsApp(from, reply);

            // =========================
            // 🔹 Token Creation Process
            // =========================
            const mint = await createMint(
              connection,
              payer,
              payer.publicKey,
              session.data.freezeAuthority ? payer.publicKey : null,
              session.data.decimals
            );

            const tokenAccount = await getOrCreateAssociatedTokenAccount(
              connection,
              payer,
              mint,
              payer.publicKey
            );

            const mintTxSig = await mintTo(
              connection,
              payer,
              mint,
              tokenAccount.address,
              payer.publicKey,
              session.data.supply * Math.pow(10, session.data.decimals)
            );

            const explorerLink = `https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`;

            reply =
              `✅ *Token Successfully Launched!*\n\n` +
              `🏷️ Name: ${session.data.name}\n` +
              `💠 Symbol: ${session.data.symbol}\n` +
              `💰 Supply: ${session.data.supply}\n` +
              `🔢 Decimals: ${session.data.decimals}\n\n` +
              `🪙 Mint Address:\n${mint.toBase58()}\n\n` +
              `📜 Transaction Signature:\n${mintTxSig}\n\n` +
              `🌐 Explorer Link:\n${explorerLink}\n\n` +
              `_Note: This token is on Solana Devnet (test network)._`;

            session.step = 9;
          } else if (body.toLowerCase() === "cancel") {
            reply = "❌ Token launch cancelled. Type *launch token* to start again.";
            sessions.delete(from);
          } else {
            reply = "Please type *confirm* to deploy or *cancel* to stop.";
          }
          break;

        default:
          reply = "Type *launch token* to start a new token creation process.";
          break;
      }
    }
  } catch (err) {
    console.error(err);
    reply = "⚠️ An error occurred while creating your token.";
  }

  await sendWhatsApp(from, reply);
  res.sendStatus(200);
});

// =========================
// 🔹 Helper Function
// =========================
async function sendWhatsApp(to, message) {
  await client.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body: message,
  });
}

// =========================
// 🔹 Start Server
// =========================
app.listen(PORT, () => {
  console.log(`✅ WhatsApp Token Launch Bot running on port ${PORT}`);
});
