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
  getMint,
} from "@solana/spl-token";
import {
  createMetadataAccountV3,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { 
  keypairIdentity, 
  publicKey as umiPublicKey,
  createSignerFromKeypair,
} from "@metaplex-foundation/umi";
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
app.post("/incoming", async (req, res) => {
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
        const supply = parseInt(msg);
        if (isNaN(supply) || supply <= 0) {
          await sendMessage(from, "❌ Invalid supply. Please enter a positive number:");
          break;
        }
        user.token.supply = supply;
        user.stage = "launch_decimals";
        await sendMessage(from, "Enter decimals (usually 9):");
        break;

      case "launch_decimals":
        const decimals = parseInt(msg);
        if (isNaN(decimals) || decimals < 0 || decimals > 9) {
          await sendMessage(from, "❌ Invalid decimals. Please enter a number between 0-9:");
          break;
        }
        user.token.decimals = decimals;
        user.stage = "launch_confirm";
        const t = user.token;
        await sendMessage(
          from,
          `⚙️ Confirm token details:\nName: ${t.name}\nSymbol: ${t.symbol}\nStory: ${t.story}\nSupply: ${t.supply}\nDecimals: ${t.decimals}\n\nType "confirm" or "cancel".`
        );
        break;

      case "launch_confirm":
        if (msg.toLowerCase() === "confirm") {
          const kp = user.wallet;
          const t = user.token;

          await sendMessage(from, "⏳ Creating your token with metadata...");

          // Create the mint
          const mint = await createMint(connection, kp, kp.publicKey, null, t.decimals);
          
          // Create UMI instance for Metaplex
          const umi = createUmi(connection.rpcEndpoint);
          const umiKeypair = umi.eddsa.createKeypairFromSecretKey(kp.secretKey);
          const signer = createSignerFromKeypair(umi, umiKeypair);
          umi.use(keypairIdentity(signer));

          // Create metadata
          await createMetadataAccountV3(umi, {
            mint: umiPublicKey(mint.toBase58()),
            mintAuthority: signer,
            payer: signer,
            updateAuthority: signer.publicKey,
            data: {
              name: t.name,
              symbol: t.symbol,
              uri: "", // You can add IPFS/Arweave link later
              sellerFeeBasisPoints: 0,
              creators: null,
              collection: null,
              uses: null,
            },
            isMutable: true,
            collectionDetails: null,
          }).sendAndConfirm(umi);

          // Mint tokens
          const ata = await getOrCreateAssociatedTokenAccount(connection, kp, mint, kp.publicKey);
          const amount = BigInt(t.supply) * BigInt(10 ** t.decimals);
          await mintTo(connection, kp, mint, ata.address, kp, amount);

          await sendMessage(
            from,
            `✅ Token Created with Metadata!\n${t.name} (${t.symbol})\n📖 ${t.story}\nMint: ${mint.toBase58()}\n🔗 View:\nhttps://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`
          );
          user.stage = "main_menu";
        } else if (msg.toLowerCase() === "cancel") {
          user.stage = "main_menu";
          await sendMessage(from, "❌ Token launch cancelled.");
        } else {
          await sendMessage(from, "Please type 'confirm' or 'cancel'.");
        }
        break;

      // ------------------- SEND TOKEN -------------------
      case "awaiting_send_mint":
        try {
          // Validate mint address
          new PublicKey(msg);
          user.transfer = { mint: msg };
          user.stage = "awaiting_send_receiver";
          await sendMessage(from, "Enter receiver wallet address:");
        } catch {
          await sendMessage(from, "❌ Invalid mint address. Please enter a valid Solana address:");
        }
        break;

      case "awaiting_send_receiver":
        try {
          // Validate receiver address
          new PublicKey(msg);
          user.transfer.receiver = msg;
          user.stage = "awaiting_send_amount";
          await sendMessage(from, "Enter amount to send:");
        } catch {
          await sendMessage(from, "❌ Invalid wallet address. Please enter a valid Solana address:");
        }
        break;

      case "awaiting_send_amount":
        try {
          const mintPubkey = new PublicKey(user.transfer.mint);
          const receiverPubkey = new PublicKey(user.transfer.receiver);
          const amountInput = parseFloat(msg);

          if (isNaN(amountInput) || amountInput <= 0) {
            await sendMessage(from, "❌ Invalid amount. Please enter a positive number:");
            break;
          }

          await sendMessage(from, "⏳ Processing transfer...");

          // Get mint info to determine decimals
          const mintInfo = await getMint(connection, mintPubkey);
          const decimals = mintInfo.decimals;
          const amount = BigInt(Math.floor(amountInput * (10 ** decimals)));

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

          await sendMessage(from, `✅ Sent ${amountInput} tokens to ${receiverPubkey.toBase58()} on Devnet.`);
        } catch (error) {
          console.error("Transfer error:", error);
          await sendMessage(from, "❌ Transfer failed. Please check the addresses and try again.");
          user.stage = "main_menu";
        }
        break;

      // ------------------- MAIN MENU COMMANDS -------------------
      case "main_menu":
        if (msg.toLowerCase() === "/launch") {
          user.stage = "launch_name";
          user.token = {};
          await sendMessage(from, "Let's launch your token!\nEnter token name:");
        } else if (msg.toLowerCase() === "/send") {
          user.stage = "awaiting_send_mint";
          await sendMessage(from, "Enter token mint address:");
        } else {
          await sendMessage(from, "❓ Unknown command. Use /launch or /send.");
        }
        break;

      default:
        await sendMessage(from, "❓ Unknown command. Use /launch or /send.");
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