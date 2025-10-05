import express from "express";
import twilio from "twilio";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const app = express();
app.use(express.urlencoded({ extended: false }));

// In-memory user state
const userWallets = {}; // { phoneNumber: { publicKey, secretKey } }
let tokenPrice = 0.000001; // starting price (mock bonding curve)
let tokensSold = 0;

// --- Command parser ---
function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

// --- Command handlers ---
function handleCommand(from, body) {
  const { cmd, args } = parseCommand(body);

  // Require wallet import first
  if (!userWallets[from] && cmd !== "/import") {
    return "⚠️ Please import your wallet first using: /import [privateKeyArray] or /import <base58Key>";
  }

  switch (cmd) {
    case "/ping":
      return "pong 🏓";

    case "/import": {
      if (args.length < 1) {
        return "❌ Usage:\n- /import [12,34,...] (JSON array)\n- /import <base58Key>";
      }
      try {
        let secretKey;
        const raw = args.join(" ");

        if (raw.startsWith("[")) {
          // JSON array format
          secretKey = new Uint8Array(JSON.parse(raw));
        } else {
          // Assume base58 string format
          secretKey = bs58.decode(raw);
        }

        const keypair = Keypair.fromSecretKey(secretKey);

        userWallets[from] = {
          publicKey: keypair.publicKey.toBase58(),
          secretKey: Array.from(secretKey), // ⚠️ unsafe for prod
        };

        return `✅ Wallet imported!\nYour address: ${keypair.publicKey.toBase58()}`;
      } catch (err) {
        return "❌ Invalid private key format. Use either:\n- JSON array: /import [12,34,...]\n- Base58 string: /import <yourKey>";
      }
    }

    case "/buy": {
      if (args.length < 1) return "❌ Usage: /buy <amountSOL>";
      const sol = parseFloat(args[0]);
      if (isNaN(sol) || sol <= 0) return "❌ Invalid SOL amount.";

      const tokens = sol * 1000;
      tokensSold += tokens;
      tokenPrice += 0.000000001 * tokens;

      return `✅ Bought ${tokens} tokens for ${sol} SOL.\nCurrent price: ${tokenPrice.toFixed(9)} SOL/token`;
    }

    case "/sell": {
      if (args.length < 1) return "❌ Usage: /sell <amountTokens>";
      const amt = parseInt(args[0], 10);
      if (isNaN(amt) || amt <= 0) return "❌ Invalid token amount.";

      const solReturned = amt / 1000;
      tokensSold = Math.max(0, tokensSold - amt);
      tokenPrice = Math.max(0.000001, tokenPrice - 0.000000001 * amt);

      return `✅ Sold ${amt} tokens for ${solReturned} SOL.\nCurrent price: ${tokenPrice.toFixed(9)} SOL/token`;
    }

    default:
      return "❓ Unknown command. Try /ping, /import, /buy <SOL>, /sell <tokens>";
  }
}

// --- Webhook route for Twilio ---
app.post("/incoming", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming message:", from, body);

  const reply = handleCommand(from, body);

  // Build TwiML reply
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.type("text/xml").send(twiml.toString());
});

// Start server (Render-compatible)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
