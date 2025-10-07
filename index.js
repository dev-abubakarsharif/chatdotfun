import express from "express";
import twilio from "twilio";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const app = express();
app.use(express.urlencoded({ extended: false }));

// === In-memory data ===
const userWallets = {}; // { phoneNumber: { publicKey, secretKey } }
const userLaunchState = {}; // step-based flow for launching
const launchedTokens = {}; // { ticker: { name, ticker, supply, liquidity, owner } }

let tokenPrice = 0.000001; // base price (mock bonding curve)
let tokensSold = 0;

// --- Helper: Parse command ---
function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

// --- Command Handlers ---
function handleCommand(from, body) {
  const { cmd, args } = parseCommand(body);
  const wallet = userWallets[from];

  // === Require wallet import before other actions ===
  if (!wallet && cmd !== "/import") {
    return "⚠️ Please import your wallet first using: /import [privateKeyArray] or /import <base58Key>";
  }

  // === Handle ongoing launch session ===
  if (userLaunchState[from] && cmd !== "/launch") {
    return continueLaunchFlow(from, body);
  }

  switch (cmd) {
    case "/ping":
      return "pong 🏓";

    // ===== WALLET IMPORT =====
    case "/import": {
      if (args.length < 1) {
        return "❌ Usage:\n- /import [12,34,...] (JSON array)\n- /import <base58Key>";
      }
      try {
        let secretKey;
        const raw = args.join(" ");

        if (raw.startsWith("[")) {
          secretKey = new Uint8Array(JSON.parse(raw));
        } else {
          secretKey = bs58.decode(raw);
        }

        const keypair = Keypair.fromSecretKey(secretKey);
        userWallets[from] = {
          publicKey: keypair.publicKey.toBase58(),
          secretKey: Array.from(secretKey),
        };
        return `✅ Wallet imported!\nYour address: ${keypair.publicKey.toBase58()}`;
      } catch (err) {
        return "❌ Invalid private key format. Use either:\n- JSON array: /import [12,34,...]\n- Base58 string: /import <yourKey>";
      }
    }

    // ===== TOKEN LAUNCH FLOW =====
    case "/launch":
      userLaunchState[from] = { step: 1, data: {} };
      return "🚀 Let’s launch your coin!\nEnter token name:";

    // ===== INSTANT BUY (e.g. /buy $CKING 0.5 SOL) =====
    case "/buy": {
      if (args.length < 2)
        return "❌ Usage:\n/buy $TICKER <SOL_amount>\nExample: /buy $CKING 0.5";

      const ticker = args[0].replace("$", "").toUpperCase();
      const solAmount = parseFloat(args[1]);

      if (!launchedTokens[ticker]) return `❌ Token $${ticker} not found.`;
      if (isNaN(solAmount) || solAmount <= 0)
        return "❌ Invalid SOL amount.";

      // mock conversion
      const tokens = solAmount * 150000; // just mock math for illustration

      return `🛒 Buying ${solAmount} SOL of $${ticker}…\n✅ Success! You now hold ${tokens.toLocaleString()} $${ticker}.\n[Sell] [Chart] [Portfolio]`;
    }

    // ===== OLD BUY/SELL STILL VALID =====
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
      return "❓ Unknown command. Try /ping, /import, /launch, /buy $TICKER <SOL>, /sell <tokens>";
  }
}

// --- Launch flow continuation ---
function continueLaunchFlow(from, msg) {
  const state = userLaunchState[from];

  switch (state.step) {
    case 1:
      state.data.name = msg.trim();
      state.step = 2;
      return `✅ Name set: ${state.data.name}\nNow enter ticker (e.g. $CKING):`;

    case 2:
      state.data.ticker = msg.replace("$", "").toUpperCase();
      state.step = 3;
      return `✅ Ticker set: $${state.data.ticker}\nEnter supply:`;

    case 3:
      const supply = parseInt(msg.replace(/,/g, ""), 10);
      if (isNaN(supply) || supply <= 0 || supply > 1_000_000_000)
        return "❌ Invalid supply. Enter a number up to 1,000,000,000.";
      state.data.supply = supply.toLocaleString();
      state.step = 4;
      return `✅ Supply set: ${state.data.supply} (max is 1B)\nEnter initial liquidity (min 0.5 SOL):`;

    case 4:
      const liquidity = parseFloat(msg);
      if (isNaN(liquidity) || liquidity < 0.5)
        return "❌ Minimum liquidity is 0.5 SOL.";
      state.data.liquidity = liquidity;

      const { name, ticker } = state.data;
      launchedTokens[ticker] = {
        ...state.data,
        owner: userWallets[from]?.publicKey,
      };

      delete userLaunchState[from];
      return `🎉 ${name} ($${ticker}) launched!\nPosted to Channel.\n[View in Channel] [My Portfolio]`;

    default:
      delete userLaunchState[from];
      return "❌ Launch flow cancelled. Type /launch to start again.";
  }
}

// --- Twilio webhook ---
app.post("/incoming", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  console.log("Incoming:", from, body);

  const reply = handleCommand(from, body);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
