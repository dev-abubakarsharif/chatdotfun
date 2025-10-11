/**
 * index.js
 * Chat.fun WhatsApp bot MVP (Twilio) - Render ready
 *
 * - Keeps /import logic as-is (supports JSON array secret or base58)
 * - Implements onboarding, launch, buy, sell flows (stateful per phone number)
 * - Simulates "buttons" via text/emoji/number choices
 *
 * Note: for production, DO NOT store secret keys in memory as arrays — this is unsafe.
 */

import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

dotenv.config();

const app = express();
// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ----------------- In-memory stores -----------------
const userWallets = {};       // { phone: { publicKey, secretKey } }
const userState = {};         // { phone: { step: "...", data: {...} } }
const launchedTokens = {};    // { TICKER: { name, ticker, supply, liquidity, description, community, owner } }
const portfolios = {};        // { phone: { TICKER: amountTokens } }

// Mock market state (simple bonding curve-ish)
let globalTokensSold = 0;
const BASE_PRICE = 0.000001; // base price per token in SOL

// ----------------- Helpers -----------------
function respondText(text) {
  // simple wrapper for TwiML MessagingResponse usage in webhook
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  return twiml.toString();
}

function isLikelyPrivateKey(text) {
  // crude heuristics: JSON array, many words (seed phrase), or base58-like long string
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return true;               // JSON array
  const words = trimmed.split(/\s+/);
  if (words.length >= 12 && words.length <= 24) return true; // seed phrase length range
  if (/^[A-HJ-NP-Za-km-z1-9]{32,100}$/.test(trimmed)) return true; // base58-ish
  return false;
}

function sendMainMenu() {
  // simulate buttons via emoji + instruction
  return [
    "You’re ready to cook, anon 🔥",
    "",
    "Choose an option (reply with the text, emoji or the number):",
    "1️⃣  🚀 Launch Token",
    "2️⃣  💸 Buy Token",
    "3️⃣  📊 My Portfolio",
    "4️⃣  🔥 Trending Launches",
    "",
    'Or you can use commands directly: "/launch", "/buy $TICKER", "/sell $TICKER <amount>"'
  ].join("\n");
}

function formatNumber(n) {
  return Number(n).toLocaleString();
}

function getTokenPrice(ticker) {
  // simple mock: price increases slightly with tokens sold
  // Price = BASE_PRICE * (1 + globalTokensSold / 1e7)
  const multiplier = 1 + (globalTokensSold / 1e7);
  return BASE_PRICE * multiplier;
}

// ----------------- Wallet import (kept as-is, but also accept raw paste) -----------------
function tryImportWallet(from, rawText) {
  try {
    let secretKey;
    const raw = rawText.trim();

    if (raw.startsWith("[")) {
      // JSON array format
      secretKey = new Uint8Array(JSON.parse(raw));
    } else {
      // Assume base58 string or seed phrase without brackets
      // If it's a seed phrase (words), we can't convert to Keypair here.
      // We'll attempt base58 decode; if it fails, throw.
      secretKey = bs58.decode(raw);
    }

    const keypair = Keypair.fromSecretKey(secretKey);

    userWallets[from] = {
      publicKey: keypair.publicKey.toBase58(),
      secretKey: Array.from(secretKey), // ⚠️ unsafe for production
    };

    // initialize portfolio if not present
    if (!portfolios[from]) portfolios[from] = {};

    return {
      success: true,
      message: `✅ Wallet imported!\nYour address: ${keypair.publicKey.toBase58()}\n\n` + sendMainMenu(),
    };
  } catch (err) {
    return { success: false, message: null };
  }
}

// ----------------- Launch Flow Handlers -----------------
function startLaunchFlow(from) {
  userState[from] = { step: "launch_name", data: {} };
  return "🚀 Let’s launch your coin!\nWhat’s your token name? (e.g. PEPEWHALE)";
}

function continueLaunchFlow(from, msg) {
  const st = userState[from];
  if (!st) return "❌ No launch in progress.";

  const step = st.step;
  const text = msg.trim();

  if (step === "launch_name") {
    st.data.name = text;
    st.step = "launch_ticker";
    return `✅ Name set: ${st.data.name}\nNow enter ticker (e.g. $CKING):`;
  }

  if (step === "launch_ticker") {
    st.data.ticker = text.replace("$", "").toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(st.data.ticker)) {
      return "❌ Invalid ticker. Use 1-8 letters/numbers (e.g. $CKING). Enter ticker:";
    }
    if (launchedTokens[st.data.ticker]) {
      return `❌ Ticker $${st.data.ticker} already exists. Pick another ticker:`;
    }
    st.step = "launch_supply";
    return `✅ Ticker set: $${st.data.ticker}\nEnter supply (max 1,000,000,000):`;
  }

  if (step === "launch_supply") {
    const supply = parseInt(text.replace(/,/g, ""), 10);
    if (isNaN(supply) || supply <= 0 || supply > 1_000_000_000) {
      return "❌ Invalid supply. Enter a number up to 1,000,000,000:";
    }
    st.data.supply = supply;
    st.step = "launch_liquidity";
    return `✅ Supply set: ${formatNumber(supply)} (max is 1B)\nEnter initial liquidity (min 0.5 SOL):`;
  }

  if (step === "launch_liquidity") {
    const liquidity = parseFloat(text);
    if (isNaN(liquidity) || liquidity < 0.5) {
      return "❌ Minimum liquidity is 0.5 SOL. Enter initial liquidity (min 0.5 SOL):";
    }
    st.data.liquidity = liquidity;
    st.step = "launch_description";
    return `✅ Liquidity set: ${liquidity} SOL\nEnter token description/story:`;
  }

  if (step === "launch_description") {
    st.data.description = text;
    st.step = "launch_community";
    return "✅ Description saved!\nEnter your community link (Telegram, Twitter, or Discord):";
  }

  if (step === "launch_community") {
    st.data.community = text;
    st.step = "launch_confirm";

    const d = st.data;
    return [
      "🧠 Final check:",
      `Name: ${d.name}`,
      `Ticker: $${d.ticker}`,
      `Supply: ${formatNumber(d.supply)}`,
      `Initial Liquidity: ${d.liquidity} SOL`,
      `Description: ${d.description}`,
      `Community: ${d.community}`,
      "",
      "Ready to launch? Reply with: ✅ Launch   or   ❌ Cancel"
    ].join("\n");
  }

  if (step === "launch_confirm") {
    if (text.includes("✅") || /^launch$/i.test(text)) {
      const d = st.data;
      // register token
      launchedTokens[d.ticker] = {
        name: d.name,
        ticker: d.ticker,
        supply: d.supply,
        liquidity: d.liquidity,
        description: d.description,
        community: d.community,
        owner: userWallets[from]?.publicKey || null,
        createdAt: Date.now(),
      };

      // optional: increment globalTokensSold or liquidity bookkeeping
      globalTokensSold += Math.floor(d.supply * 0.01); // pretend 1% sold to start

      delete userState[from];
      return `✅ Token *${d.name}* ($${d.ticker}) is LIVE on Chat.fun!\nBase Price: ${BASE_PRICE} SOL\nCurve active — buyers already aping in 🐒\n\nOptions:\n- 💸 Buy $${d.ticker}   (reply "Buy $${d.ticker}" or "/buy $${d.ticker} <SOL>")\n- 📈 View Chart\n- 📣 Share Launch`;
    }

    // Cancel
    if (text.includes("❌") || /^cancel$/i.test(text)) {
      delete userState[from];
      return `❌ Launch process cancelled.\nNo SOL deducted. No token created.\n\nChoose:\n🚀 Launch New Token\n📊 My Portfolio\n🔥 Trending Launches`;
    }

    return 'Reply "✅ Launch" to confirm or "❌ Cancel" to abort.';
  }

  // fallback
  return "❌ Unexpected launch state. Type /launch to start again.";
}

// ----------------- Buy Flow -----------------
function startBuyFlow_selectTicker(from) {
  userState[from] = { step: "buy_select_ticker", data: {} };
  const tokensList = Object.values(launchedTokens);
  if (tokensList.length === 0) {
    delete userState[from];
    return "No tokens are live yet. Try again later or launch your own token with /launch.";
  }
  const listText = tokensList.map(t => `- $${t.ticker} — ${t.name}`).join("\n");
  return `Which token do you want to buy?\nReply with ticker like: $CKING\nAvailable:\n${listText}`;
}

function continueBuyFlow(from, msg) {
  const st = userState[from];
  if (!st) return "❌ No buy flow in progress.";

  if (st.step === "buy_select_ticker") {
    const ticker = msg.replace("$", "").trim().toUpperCase();
    if (!launchedTokens[ticker]) return `❌ Token $${ticker} not found. Reply ticker again:`;
    st.data.ticker = ticker;
    st.step = "buy_amount";
    return `How much SOL you throwing in, anon? 💰\n(e.g. 0.5)`;
  }

  if (st.step === "buy_amount") {
    const sol = parseFloat(msg);
    if (isNaN(sol) || sol <= 0) return "❌ Invalid SOL amount. Enter a number like 0.5:";
    const ticker = st.data.ticker;
    // mock conversion: tokens = sol * rate (example 48000 tokens per SOL)
    const priceNow = getTokenPrice(ticker); // per token in SOL
    // to keep numbers sane we use a mock multiplier rather than dividing by tiny price
    const tokens = Math.floor((sol / priceNow) || (sol * 48000));
    // update portfolio
    portfolios[from] = portfolios[from] || {};
    portfolios[from][ticker] = (portfolios[from][ticker] || 0) + tokens;
    // update market
    globalTokensSold += tokens;

    delete userState[from];

    const marketPriceAfter = getTokenPrice(ticker);
    // mock market cap: total tokens sold * price
    const marketCap = (globalTokensSold * marketPriceAfter).toFixed(6);

    return `✅ Bought ${formatNumber(tokens)} $${ticker} for ${sol} SOL.\nCurrent Price: ${marketPriceAfter.toFixed(9)} SOL\nMarket Cap (mock): ${marketCap} SOL\n\nOptions:\n📊 Chart\n💰 Sell\n⚡ Share Info`;
  }

  return "❌ Unexpected buy state. Type /buy $TICKER <SOL> to buy instantly or reply '💸 Buy Token' to browse tokens.";
}

// Instant /buy $TICKER <SOL> handler
function handleInstantBuy(from, parts) {
  // parts example: ["/buy", "$CKING", "0.5" ...]
  if (parts.length < 2) return "❌ Usage:\n/buy $TICKER <SOL_amount>\nExample: /buy $CKING 0.5";
  const ticker = parts[1].replace("$", "").toUpperCase();
  let solAmount = 0;
  // try find number among parts
  for (let i = 2; i < parts.length; i++) {
    const v = parseFloat(parts[i]);
    if (!isNaN(v)) {
      solAmount = v;
      break;
    }
  }
  // if not in parts[2], maybe command was "/buy $CKING 0.5SOL" or "/buy $CKING 0.5SOL"
  if (solAmount === 0 && parts[2]) {
    const m = parts[2].match(/([0-9]*\.?[0-9]+)/);
    if (m) solAmount = parseFloat(m[1]);
  }

  if (!launchedTokens[ticker]) return `❌ Token $${ticker} not found.`;
  if (isNaN(solAmount) || solAmount <= 0) return "❌ Invalid SOL amount.";

  const priceNow = getTokenPrice(ticker);
  const tokens = Math.floor((solAmount / priceNow) || (solAmount * 48000));

  portfolios[from] = portfolios[from] || {};
  portfolios[from][ticker] = (portfolios[from][ticker] || 0) + tokens;
  globalTokensSold += tokens;

  const marketPriceAfter = getTokenPrice(ticker);
  const marketCap = (globalTokensSold * marketPriceAfter).toFixed(6);

  return `🛒 Buying ${solAmount} SOL of $${ticker}…\n✅ Success! You now hold ${formatNumber(tokens)} $${ticker}.\nCurrent Price: ${marketPriceAfter.toFixed(9)} SOL\nMarket Cap (mock): ${marketCap} SOL\n\nOptions:\n📊 Chart\n💰 Sell\n⚡ Share Info`;
}

// ----------------- Sell Flow -----------------
function handleSellCommand(from, parts) {
  // formats supported: /sell $TICKER 10000  OR  /sell 10000 $TICKER  OR  "Sell $TICKER 10000"
  if (parts.length < 2) return '❌ Usage: /sell $TICKER <amountTokens>\nExample: /sell $CKING 10000';

  // extract ticker and amount
  let ticker = null;
  let amount = null;
  for (const p of parts.slice(1)) {
    if (p.includes("$")) ticker = p.replace("$", "").toUpperCase();
    const v = parseInt(p.replace(/,/g, ""), 10);
    if (!isNaN(v) && v > 0) amount = v;
  }
  // fallback guesses
  if (!ticker && parts[1]) {
    // maybe user wrote ticker without $
    if (isNaN(parseInt(parts[1].replace(/,/g, ""), 10))) {
      ticker = parts[1].toUpperCase();
    }
  }
  if (!amount) {
    // try to find in last part
    const last = parts[parts.length - 1];
    const v = parseInt(last.replace(/,/g, ""), 10);
    if (!isNaN(v)) amount = v;
  }

  if (!ticker) return "❌ Could not detect ticker. Use: /sell $TICKER <amountTokens>";
  if (!portfolios[from] || !portfolios[from][ticker] || portfolios[from][ticker] < (amount || 0)) {
    return `❌ You do not hold ${amount || 'that many'} $${ticker}. Check your portfolio.`;
  }
  if (!amount || amount <= 0) return "❌ Invalid amount to sell.";

  // perform mock sell: tokens -> SOL
  const priceNow = getTokenPrice(ticker);
  const solReturned = (amount * priceNow);
  portfolios[from][ticker] -= amount;
  globalTokensSold = Math.max(0, globalTokensSold - amount);
  const curvePrice = getTokenPrice(ticker);

  return `✅ Sold ${formatNumber(amount)} $${ticker} for ${solReturned.toFixed(6)} SOL.\nCurve Price: ${curvePrice.toFixed(9)} SOL\nVolume last 1h: +3.7 SOL\n\nOptions:\n📊 Chart\n💸 Buy More\n💰 Wallet Balance`;
}

// ----------------- Portfolio view -----------------
function viewPortfolio(from) {
  const p = portfolios[from] || {};
  const lines = ["📊 Your Portfolio:"];
  if (Object.keys(p).length === 0) return "📊 Your portfolio is empty. Buy tokens via /buy $TICKER or reply '💸 Buy Token'.";

  for (const [ticker, amt] of Object.entries(p)) {
    const price = getTokenPrice(ticker);
    const val = (amt * price).toFixed(6);
    lines.push(`- $${ticker}: ${formatNumber(amt)} — ≈ ${val} SOL`);
  }
  return lines.join("\n");
}

// ----------------- Trending / Listing -----------------
function viewTrending() {
  const tokens = Object.values(launchedTokens);
  if (tokens.length === 0) return "🔥 No trending launches yet.";
  const list = tokens.slice(0, 5).map(t => `- $${t.ticker} — ${t.name} (${t.supply.toLocaleString()} supply)`).join("\n");
  return `🔥 Trending Launches:\n${list}\n\nReply with a ticker (e.g. $CKING) to buy or /launch to create your own.`;
}

// ----------------- Main message handler -----------------
function handleIncoming(from, rawBody) {
  const body = (rawBody || "").trim();

  // 1) If user hasn't imported wallet, prompt and allow import (we keep /import behavior)
  if (!userWallets[from]) {
    // If message is explicit /import command, attempt import
    if (body.toLowerCase().startsWith("/import")) {
      const parts = body.split(/\s+/).slice(1);
      if (parts.length === 0) {
        return "❌ Usage:\n- /import [12,34,...] (JSON array)\n- /import <base58Key>\n\nYou can also paste your seed phrase or private key directly (not recommended in production).";
      }
      const raw = parts.join(" ");
      const r = tryImportWallet(from, raw);
      if (r.success) return r.message;
      return "❌ Invalid private key format. Use either:\n- JSON array: /import [12,34,...]\n- Base58 string: /import <yourKey>";
    }

    // If user pasted a private key or seed phrase directly without /import, try to import
    if (isLikelyPrivateKey(body)) {
      const r = tryImportWallet(from, body);
      if (r.success) return r.message;
      // If import failed, fallthrough to prompt
    }

    // Otherwise show onboarding prompt
    return [
      "🚀 Welcome to Chat.fun, the wildest way to launch and trade tokens on Solana, right here on WhatsApp.",
      "No apps. No websites. Just pure degen energy.",
      "",
      "⚠️ Before we start, connect your wallet.",
      "Enter your seed phrase or private key below, or use the command:",
      "",
      "/import [12,34,...]   OR   /import <base58Key>"
    ].join("\n");
  }

  // 2) If user has an active state (multi-step flows), prefer continuing it
  if (userState[from]) {
    const currentStep = userState[from].step;

    // launch continuation
    if (currentStep && currentStep.startsWith("launch_")) {
      return continueLaunchFlow(from, body);
    }

    // buy continuation
    if (currentStep && currentStep.startsWith("buy_")) {
      return continueBuyFlow(from, body);
    }
  }

  // 3) No active state: parse commands or menu choices
  const lowered = body.toLowerCase();

  // menu number choices
  if (body === "1" || lowered.includes("launch token") || lowered === "🚀" || lowered.includes("/launch")) {
    return startLaunchFlow(from);
  }

  if (body === "2" || lowered.includes("buy token") || lowered.includes("💸") || lowered.startsWith("/buy")) {
    // if it's instant buy command: /buy $TICKER 0.5
    if (lowered.startsWith("/buy")) {
      const parts = body.split(/\s+/);
      return handleInstantBuy(from, parts);
    }
    // otherwise start buy selection flow
    return startBuyFlow_selectTicker(from);
  }

  if (body === "3" || lowered.includes("portfolio") || lowered.includes("my portfolio") || lowered.includes("/portfolio")) {
    return viewPortfolio(from);
  }

  if (body === "4" || lowered.includes("trending") || lowered.includes("trending launches")) {
    return viewTrending();
  }

  // Instant buy typed like: "Buy $CKING 0.5"
  if (/^buy\s+\$/i.test(body) || /^\$[A-Za-z0-9]{1,8}\s+[0-9]/.test(body)) {
    const parts = body.split(/\s+/);
    return handleInstantBuy(from, parts);
  }

  // Sell command
  if (lowered.startsWith("/sell") || lowered.startsWith("sell ")) {
    const parts = body.split(/\s+/);
    return handleSellCommand(from, parts);
  }

  // Quick help or ping
  if (lowered.startsWith("/ping")) return "pong 🏓";

  // Unknown text -> show menu
  return sendMainMenu();
}

// ----------------- Twilio webhook -----------------
app.post("/incoming", (req, res) => {
  const from = req.body.From || req.body.from || "unknown";
  const body = req.body.Body || req.body.body || "";

  console.log(`[${new Date().toISOString()}] Incoming from ${from}: ${body}`);

  const reply = handleIncoming(from, body);
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

// Health route
app.get("/", (req, res) => {
  res.send("Chat.fun Bot is alive 🚀");
});

// Start server Render-compatible
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
