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
  getAccount,
} from "@solana/spl-token";
import {
  createV1,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { 
  keypairIdentity, 
  generateSigner,
  percentAmount,
} from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import bs58 from "bs58";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

// ------------------- TWILIO SETUP -------------------
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = "whatsapp:+14155238886";

// ------------------- SOLANA SETUP -------------------
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// ------------------- EXPRESS SETUP -------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// In-memory storage
const sessions = {};
const tokens = {};

// Helper: Send WhatsApp message
async function sendMessage(to, body) {
  try {
    await client.messages.create({ from: TWILIO_NUMBER, to, body });
  } catch (error) {
    console.error("Twilio send error:", error.message);
  }
}

// Helper: Calculate bonding curve price
function calculatePrice(supply, liquidity) {
  return liquidity / supply;
}

// Helper: Calculate tokens for SOL amount
function calculateTokensFromSOL(solAmount, currentPrice) {
  return Math.floor(solAmount / currentPrice);
}

// Helper: Calculate SOL for token amount
function calculateSOLFromTokens(tokenAmount, currentPrice) {
  return tokenAmount * currentPrice;
}

// ------------------- MAIN BOT LOGIC -------------------
app.post("/incoming", async (req, res) => {
  const from = req.body.From;
  const msg = req.body.Body?.trim();
  let user = sessions[from] || { stage: "start" };

  try {
    // Quick test
    if (msg.toLowerCase() === "hi") {
      await sendMessage(from, "👋 Hello! Chat.fun bot is online and ready on Devnet!");
      return res.status(200).end();
    }

    switch (user.stage) {
      case "start":
        await sendMessage(
          from,
          `🔥💎 Welcome to Chat.fun, the wildest way to launch and trade tokens on Solana, right here on WhatsApp.\n\nNo apps. No websites. Just pure degen energy.\n\n⚠️ Before we start, connect your wallet.\n\nEnter your seed phrase or private key below 👇`
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
            `🎉 ✅ Wallet connected successfully!\n\n💰 SOL Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)}\n\nYou're ready to cook, anon 🔥\n\n━━━━━━━━━━━━━━━\n1️⃣ 🚀 Launch Token\n2️⃣ 💰 Buy Token\n3️⃣ 📊 My Portfolio\n4️⃣ 🔥 Trending Launches\n5️⃣ 📤 Send Token\n━━━━━━━━━━━━━━━\n\nType a number or command (e.g. "1" or "/launch")`
          );
        } catch {
          await sendMessage(from, "❌ Invalid key. Please enter a valid base58 private key or seed phrase.");
        }
        break;

      // ------------------- TOKEN LAUNCH FLOW -------------------
      case "launch_name":
        user.token.name = msg;
        user.stage = "launch_ticker";
        await sendMessage(from, "What's your token ticker? (e.g. $PEPEWHALE):");
        break;

      case "launch_ticker":
        user.token.ticker = msg.startsWith('$') ? msg : `$${msg}`;
        user.stage = "launch_supply";
        await sendMessage(from, "Enter total supply (e.g. 1000000):");
        break;

      case "launch_supply":
        const supply = parseInt(msg);
        if (isNaN(supply) || supply <= 0) {
          await sendMessage(from, "❌ Invalid supply. Enter a positive number:");
          break;
        }
        user.token.supply = supply;
        user.stage = "launch_liquidity";
        await sendMessage(from, "Enter initial liquidity in SOL (minimum 0.5 SOL):");
        break;

      case "launch_liquidity":
        const liquidity = parseFloat(msg);
        if (isNaN(liquidity) || liquidity < 0.5) {
          await sendMessage(from, "❌ Minimum 0.5 SOL required. Try again:");
          break;
        }
        user.token.liquidity = liquidity;
        user.stage = "launch_description";
        await sendMessage(from, "Tell us the story behind your token 📖:");
        break;

      case "launch_description":
        user.token.description = msg;
        user.stage = "launch_community";
        await sendMessage(from, "Drop your community link (Telegram/Twitter/Discord):");
        break;

      case "launch_community":
        user.token.community = msg;
        user.stage = "launch_confirm";
        const t = user.token;
        const basePrice = calculatePrice(t.supply, t.liquidity);
        await sendMessage(
          from,
          `🔥 Final check:\n\nName: ${t.name}\nTicker: ${t.ticker}\nSupply: ${t.supply.toLocaleString()}\nInitial Liquidity: ${t.liquidity} SOL\nBase Price: ${basePrice.toFixed(9)} SOL\nDescription: ${t.description}\nCommunity: ${t.community}\n\nReady to launch?\n\nType "✅ Launch" or "❌ Cancel"`
        );
        break;

      case "launch_confirm":
        if (msg.toLowerCase().includes("launch") || msg === "✅") {
          const kp = user.wallet;
          const t = user.token;

          // Check balance
          const balance = await connection.getBalance(kp.publicKey);
          const requiredSOL = (t.liquidity + 0.01) * LAMPORTS_PER_SOL;

          if (balance < requiredSOL) {
            await sendMessage(
              from,
              `❌ Insufficient balance!\n\nYou need ${t.liquidity + 0.01} SOL but have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL.\n\nGet more SOL from: https://faucet.solana.com/`
            );
            user.stage = "main_menu";
            break;
          }

          await sendMessage(from, "⏳ Launching your token...");

          try {
            // Create token with metadata
            const umi = createUmi(connection.rpcEndpoint);
            const umiKeypair = fromWeb3JsKeypair(kp);
            umi.use(keypairIdentity(umiKeypair));

            const mintSigner = generateSigner(umi);

            await createV1(umi, {
              mint: mintSigner,
              authority: umiKeypair,
              name: t.name,
              symbol: t.ticker.replace('$', ''),
              uri: "",
              sellerFeeBasisPoints: percentAmount(0),
              decimals: 9,
              tokenStandard: TokenStandard.Fungible,
            }).sendAndConfirm(umi);

            const mintPubkey = new PublicKey(mintSigner.publicKey);

            // Mint tokens to creator
            const ata = await getOrCreateAssociatedTokenAccount(
              connection,
              kp,
              mintPubkey,
              kp.publicKey
            );
            const amount = BigInt(t.supply) * BigInt(10 ** 9);
            await mintTo(connection, kp, mintPubkey, ata.address, kp, amount);

            // Store token info
            const tokenId = mintPubkey.toBase58();
            tokens[tokenId] = {
              name: t.name,
              ticker: t.ticker,
              supply: t.supply,
              liquidity: t.liquidity,
              description: t.description,
              community: t.community,
              creator: kp.publicKey.toBase58(),
              holders: { [kp.publicKey.toBase58()]: t.supply },
              volume24h: 0,
              marketCap: t.liquidity,
              basePrice: calculatePrice(t.supply, t.liquidity),
              launched: Date.now(),
            };

            const basePrice = tokens[tokenId].basePrice;

            await sendMessage(
              from,
              `✅ Token *${t.ticker}* is LIVE on Chat.fun!\n\n💎 Base Price: ${basePrice.toFixed(9)} SOL\n🔥 Market Cap: ${t.liquidity} SOL\n📊 Curve active — buyers already aping in 🚀\n\n🔗 Mint: ${tokenId}\n🌐 Explorer: https://explorer.solana.com/address/${tokenId}?cluster=devnet\n\n━━━━━━━━━━━━━━━\n1️⃣ 💰 Buy ${t.ticker}\n2️⃣ 📈 View Chart\n3️⃣ 📤 Share\n4️⃣ 🏠 Main Menu\n━━━━━━━━━━━━━━━\n\nType a number or command`
            );
            user.lastToken = t.ticker;
            user.stage = "main_menu";
          } catch (error) {
            console.error("Token launch error:", error);
            await sendMessage(from, "⚠️ Launch failed. Please try again or check your balance.");
            user.stage = "main_menu";
          }
        } else if (msg.toLowerCase().includes("cancel") || msg === "❌") {
          user.stage = "main_menu";
          await sendMessage(
            from,
            `❌ Launch process cancelled.\n\nNo SOL deducted. No token created.\n\nYou can start again anytime, anon.\n\n━━━━━━━━━━━━━━━\n1️⃣ 🚀 Launch New Token\n2️⃣ 📊 My Portfolio\n3️⃣ 🔥 Trending Launches\n4️⃣ 💰 Buy Token\n━━━━━━━━━━━━━━━\n\nType a number or command`
          );
        } else {
          await sendMessage(from, 'Please type "✅ Launch" or "❌ Cancel"');
        }
        break;

      // ------------------- BUY TOKEN FLOW -------------------
      case "awaiting_buy_ticker":
        user.buy = { ticker: msg };
        user.stage = "awaiting_buy_amount";
        await sendMessage(from, "How much SOL you throwing in, anon? 🔥");
        break;

      case "awaiting_buy_amount":
        try {
          const solAmount = parseFloat(msg);
          if (isNaN(solAmount) || solAmount <= 0) {
            await sendMessage(from, "❌ Invalid amount. Enter SOL amount:");
            break;
          }

          const ticker = user.buy.ticker;
          const tokenEntry = Object.entries(tokens).find(([_, t]) => t.ticker === ticker);

          if (!tokenEntry) {
            await sendMessage(from, `❌ Token ${ticker} not found. Use /trending to see available tokens.`);
            user.stage = "main_menu";
            break;
          }

          const [tokenMint, tokenData] = tokenEntry;
          const currentPrice = calculatePrice(tokenData.supply, tokenData.liquidity + solAmount);
          const tokensReceived = calculateTokensFromSOL(solAmount, currentPrice);

          // Update token data (simplified - in production use smart contract)
          tokenData.liquidity += solAmount;
          tokenData.volume24h += solAmount;
          tokenData.marketCap = tokenData.liquidity;

          const userPubkey = user.wallet.publicKey.toBase58();
          tokenData.holders[userPubkey] = (tokenData.holders[userPubkey] || 0) + tokensReceived;

          await sendMessage(
            from,
            `✅ Bought ${tokensReceived.toLocaleString()} ${ticker} for ${solAmount} SOL!\n\n💎 Current Price: ${currentPrice.toFixed(9)} SOL\n📊 Market Cap: ${tokenData.marketCap.toFixed(2)} SOL\n\nHold tight or send it 🚀\n\n━━━━━━━━━━━━━━━\n1️⃣ 📈 View Chart\n2️⃣ 💸 Sell ${ticker}\n3️⃣ 📤 Share\n4️⃣ 🏠 Main Menu\n━━━━━━━━━━━━━━━\n\nType a number or command`
          );
          user.lastToken = ticker;
          user.stage = "main_menu";
        } catch (error) {
          console.error("Buy error:", error);
          await sendMessage(from, "❌ Purchase failed. Try again later.");
          user.stage = "main_menu";
        }
        break;

      // ------------------- SEND TOKEN FLOW -------------------
      case "awaiting_send_token":
        try {
          new PublicKey(msg);
          user.send = { mint: msg };
          user.stage = "awaiting_send_receiver";
          await sendMessage(from, "Enter receiver wallet address 📬:");
        } catch {
          await sendMessage(from, "❌ Invalid token address. Please enter a valid mint address:");
        }
        break;

      case "awaiting_send_receiver":
        try {
          new PublicKey(msg);
          user.send.receiver = msg;
          user.stage = "awaiting_send_amount_tokens";
          await sendMessage(from, "How many tokens to send? 📦");
        } catch {
          await sendMessage(from, "❌ Invalid wallet address. Please enter a valid Solana address:");
        }
        break;

      case "awaiting_send_amount_tokens":
        try {
          const tokenAmount = parseFloat(msg);
          if (isNaN(tokenAmount) || tokenAmount <= 0) {
            await sendMessage(from, "❌ Invalid amount. Enter a positive number:");
            break;
          }

          const mintPubkey = new PublicKey(user.send.mint);
          const receiverPubkey = new PublicKey(user.send.receiver);

          await sendMessage(from, "⏳ Sending tokens...");

          // Get mint info
          const mintInfo = await getMint(connection, mintPubkey);
          const decimals = mintInfo.decimals;
          const amount = BigInt(Math.floor(tokenAmount * (10 ** decimals)));

          // Get sender's token account
          const fromAta = await getOrCreateAssociatedTokenAccount(
            connection,
            user.wallet,
            mintPubkey,
            user.wallet.publicKey
          );

          // Check balance
          const accountInfo = await getAccount(connection, fromAta.address);
          if (accountInfo.amount < amount) {
            await sendMessage(
              from,
              `❌ Insufficient balance!\n\nYou have ${Number(accountInfo.amount) / (10 ** decimals)} tokens\nTrying to send ${tokenAmount} tokens`
            );
            user.stage = "main_menu";
            break;
          }

          // Get or create receiver's token account
          const toAta = await getOrCreateAssociatedTokenAccount(
            connection,
            user.wallet,
            mintPubkey,
            receiverPubkey
          );

          // Transfer tokens
          await transfer(
            connection,
            user.wallet,
            fromAta.address,
            toAta.address,
            user.wallet,
            amount
          );

          await sendMessage(
            from,
            `✅ Sent ${tokenAmount} tokens!\n\n📤 To: ${receiverPubkey.toBase58()}\n🔗 Mint: ${mintPubkey.toBase58()}\n\n🌐 View on Explorer:\nhttps://explorer.solana.com/tx/${receiverPubkey.toBase58()}?cluster=devnet\n\n━━━━━━━━━━━━━━━\n1️⃣ 📤 Send More\n2️⃣ 📊 Portfolio\n3️⃣ 🏠 Main Menu\n━━━━━━━━━━━━━━━`
          );
          user.stage = "main_menu";
        } catch (error) {
          console.error("Send error:", error);
          await sendMessage(from, `❌ Transfer failed: ${error.message}\n\nMake sure you have enough tokens and the addresses are correct.`);
          user.stage = "main_menu";
        }
        break;

      // ------------------- SELL TOKEN FLOW -------------------
      case "awaiting_sell_ticker":
        user.sell = { ticker: msg };
        user.stage = "awaiting_sell_amount";
        await sendMessage(from, "How many tokens you dumping? 📉");
        break;

      case "awaiting_sell_amount":
        try {
          const tokenAmount = parseInt(msg);
          if (isNaN(tokenAmount) || tokenAmount <= 0) {
            await sendMessage(from, "❌ Invalid amount. Enter token amount:");
            break;
          }

          const ticker = user.sell.ticker;
          const tokenEntry = Object.entries(tokens).find(([_, t]) => t.ticker === ticker);

          if (!tokenEntry) {
            await sendMessage(from, `❌ Token ${ticker} not found.`);
            user.stage = "main_menu";
            break;
          }

          const [tokenMint, tokenData] = tokenEntry;
          const userPubkey = user.wallet.publicKey.toBase58();
          const userBalance = tokenData.holders[userPubkey] || 0;

          if (userBalance < tokenAmount) {
            await sendMessage(from, `❌ Insufficient balance! You have ${userBalance.toLocaleString()} ${ticker}`);
            user.stage = "main_menu";
            break;
          }

          const currentPrice = calculatePrice(tokenData.supply, tokenData.liquidity);
          const solReceived = calculateSOLFromTokens(tokenAmount, currentPrice);

          // Update token data
          tokenData.liquidity -= solReceived;
          tokenData.volume24h += solReceived;
          tokenData.holders[userPubkey] -= tokenAmount;

          await sendMessage(
            from,
            `✅ Sold ${tokenAmount.toLocaleString()} ${ticker} for ${solReceived.toFixed(4)} SOL!\n\n💎 Curve Price: ${currentPrice.toFixed(9)} SOL\n📊 Volume last 1h: +${tokenData.volume24h.toFixed(2)} SOL\n\n━━━━━━━━━━━━━━━\n1️⃣ 📈 View Chart\n2️⃣ 💰 Buy More\n3️⃣ 💼 My Portfolio\n4️⃣ 🏠 Main Menu\n━━━━━━━━━━━━━━━\n\nType a number or command`
          );
          user.lastToken = ticker;
          user.stage = "main_menu";
        } catch (error) {
          console.error("Sell error:", error);
          await sendMessage(from, "❌ Sale failed. Try again later.");
          user.stage = "main_menu";
        }
        break;

      // ------------------- MAIN MENU COMMANDS -------------------
      case "main_menu":
        const cmd = msg.toLowerCase();

        // Handle numbered options
        if (cmd === "1" || cmd === "/launch") {
          user.stage = "launch_name";
          user.token = {};
          await sendMessage(from, "Let's drop some heat 🔥\n\nWhat's your token name? (e.g. PEPEWHALE)");
        } 
        
        else if (cmd === "2" || cmd.startsWith("/buy")) {
          const ticker = msg.split(" ")[1];
          if (ticker) {
            user.buy = { ticker };
            user.stage = "awaiting_buy_amount";
            await sendMessage(from, "How much SOL you throwing in, anon? 🔥");
          } else {
            user.stage = "awaiting_buy_ticker";
            await sendMessage(from, "Which token you buying? (e.g. $PEPEWHALE)");
          }
        }

        else if (cmd === "3" || cmd === "/portfolio") {
          const userPubkey = user.wallet.publicKey.toBase58();
          let portfolio = "📊 *Your Portfolio*\n\n";
          let hasTokens = false;

          for (const [mint, data] of Object.entries(tokens)) {
            const balance = data.holders[userPubkey] || 0;
            if (balance > 0) {
              hasTokens = true;
              const value = balance * calculatePrice(data.supply, data.liquidity);
              portfolio += `${data.ticker}: ${balance.toLocaleString()} (~${value.toFixed(4)} SOL)\n`;
            }
          }

          if (!hasTokens) {
            portfolio += "No tokens yet. Time to ape in! 🚀";
          }

          portfolio += "\n\n━━━━━━━━━━━━━━━\n1️⃣ 🚀 Launch Token\n2️⃣ 💰 Buy Token\n3️⃣ 🔥 Trending\n━━━━━━━━━━━━━━━";

          await sendMessage(from, portfolio);
        }

        else if (cmd === "4" || cmd === "/trending") {
          let trending = "🔥 *Trending Launches*\n\n";
          const sortedTokens = Object.entries(tokens)
            .sort(([, a], [, b]) => b.volume24h - a.volume24h)
            .slice(0, 5);

          if (sortedTokens.length === 0) {
            trending += "No tokens launched yet. Be the first! 🚀";
          } else {
            sortedTokens.forEach(([mint, data], i) => {
              trending += `${i + 1}. ${data.ticker} - ${data.name}\n`;
              trending += `   💰 MC: ${data.marketCap.toFixed(2)} SOL | 📊 Vol: ${data.volume24h.toFixed(2)} SOL\n\n`;
            });
          }

          trending += "\n━━━━━━━━━━━━━━━\n1️⃣ 🚀 Launch Token\n2️⃣ 💰 Buy Token\n3️⃣ 📊 Portfolio\n4️⃣ 📤 Send Token\n━━━━━━━━━━━━━━━";

          await sendMessage(from, trending);
        }

        else if (cmd === "5" || cmd === "/send") {
          user.stage = "awaiting_send_token";
          await sendMessage(from, "Enter the token mint address you want to send 📤:");
        }

        else if (cmd.startsWith("/sell")) {
          const parts = msg.split(" ");
          const ticker = parts[1];
          if (ticker) {
            user.sell = { ticker };
            user.stage = "awaiting_sell_amount";
            await sendMessage(from, "How many tokens you dumping? 📉");
          } else {
            user.stage = "awaiting_sell_ticker";
            await sendMessage(from, "Which token you selling? (e.g. $PEPEWHALE)");
          }
        }

        else if (cmd.startsWith("/chart")) {
          const ticker = msg.split(" ")[1] || user.lastToken;
          const tokenEntry = Object.entries(tokens).find(([_, t]) => t.ticker === ticker);

          if (tokenEntry) {
            const [mint, data] = tokenEntry;
            await sendMessage(
              from,
              `📈 *${data.ticker} Chart*\n\n💎 Price: ${calculatePrice(data.supply, data.liquidity).toFixed(9)} SOL\n📊 Market Cap: ${data.marketCap.toFixed(2)} SOL\n🔥 24h Volume: ${data.volume24h.toFixed(2)} SOL\n👥 Holders: ${Object.keys(data.holders).length}\n🔗 Community: ${data.community}\n\n🌐 View on Explorer:\nhttps://explorer.solana.com/address/${mint}?cluster=devnet\n\n━━━━━━━━━━━━━━━\n1️⃣ 💰 Buy ${ticker}\n2️⃣ 💸 Sell ${ticker}\n3️⃣ 🏠 Main Menu\n━━━━━━━━━━━━━━━`
            );
          } else {
            await sendMessage(from, "❌ Token not found. Use /trending to see available tokens.");
          }
        }

        // Context-aware numbered shortcuts (after buy/sell/launch)
        else if (user.lastToken) {
          if (cmd === "1") {
            // View chart after transaction
            const ticker = user.lastToken;
            const tokenEntry = Object.entries(tokens).find(([_, t]) => t.ticker === ticker);
            if (tokenEntry) {
              const [mint, data] = tokenEntry;
              await sendMessage(
                from,
                `📈 *${data.ticker} Chart*\n\n💎 Price: ${calculatePrice(data.supply, data.liquidity).toFixed(9)} SOL\n📊 Market Cap: ${data.marketCap.toFixed(2)} SOL\n🔥 24h Volume: ${data.volume24h.toFixed(2)} SOL\n👥 Holders: ${Object.keys(data.holders).length}\n🔗 Community: ${data.community}\n\n🌐 View on Explorer:\nhttps://explorer.solana.com/address/${mint}?cluster=devnet`
              );
            }
          } else if (cmd === "2") {
            // Sell after buy, or Buy after sell
            user.sell = { ticker: user.lastToken };
            user.stage = "awaiting_sell_amount";
            await sendMessage(from, "How many tokens you dumping? 📉");
          }
        }

        else {
          await sendMessage(
            from,
            "❓ Unknown command.\n\n━━━━━━━━━━━━━━━\n1️⃣ 🚀 Launch Token\n2️⃣ 💰 Buy Token\n3️⃣ 📊 My Portfolio\n4️⃣ 🔥 Trending Launches\n5️⃣ 📤 Send Token\n━━━━━━━━━━━━━━━\n\nType a number or command like /launch"
          );
        }
        break;

      default:
        await sendMessage(from, "❓ Type /launch to get started!");
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