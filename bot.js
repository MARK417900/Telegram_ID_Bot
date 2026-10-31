const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;

/* SERVER */
app.get("/", (req, res) => {
  res.send("✅ Bot Backend Running");
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const ADMIN_ID = 8384096916;

// ─── REQUIRED CHANNEL (users must join before ANYTHING works) ────────────────
// ⚠️ Set these two (env vars on your host, or edit the fallback values):
//   CHANNEL_ID   → "@YourChannelUsername" (public) or "-100xxxxxxxxxx" (private)
//   CHANNEL_LINK → invite link of the "Mark Zone" channel
// The bot MUST be an admin in that channel, otherwise it cannot check membership.
const CHANNEL_ID = process.env.CHANNEL_ID || "@EarnWithMark41";
const CHANNEL_LINK = process.env.CHANNEL_LINK || "https://t.me/EarnWithMark41";
// Add more entries here later if you want to force-join more chats (e.g. your old group).
const REQUIRED_CHATS = [
  { id: CHANNEL_ID, link: CHANNEL_LINK, name: "Mark Zone" },
];

// ─── REFERRAL CONFIG ──────────────────────────────────────────────────────────
// A referral is "valid" when the referred person's first account order is marked ✅ Done by admin.
const REFERRALS_FOR_FREE = 5; // every 5 valid referrals = 1 free WhatsApp/Telegram account

// What happens when admin cancels an order that was paid for?
// false = just close it (settle refund manually in chat). true = credit price to user's bot balance.
const REFUND_ON_CANCEL = false;

// ─── BUY ACCOUNT CONFIG ────────────────────────────────────────────────────
// Each account type has its own label and price (₹ per account). Change freely.
const ACCOUNT_TYPES = {
  whatsapp: { label: "📱 WhatsApp", price: 40 },
  telegram: { label: "✈️ Telegram", price: 40 },
};
const ACCOUNT_MAX_QTY = 10;
const ADD_STOCK_MAX_QTY = 500; // max per country in one add
const PAYMENT_QR = "https://raw.githubusercontent.com/MARK417900/telegram-invite-bot/main/PaymentQR.jpg";
const UPI_ID = "7891624054@mbk";

// ─── DEPOSIT CONFIG ───────────────────────────────────────────────────────────
const MIN_DEPOSIT = 10;
const MAX_DEPOSIT = 10000;

// ─── COUNTRIES (auto-created from what admin types in Add Stock) ──────────────
// Known names get a flag + spelling fixes. Anything else still works, shown as "🌍 Name".
const KNOWN_COUNTRIES = [
  { key: "india", label: "🇮🇳 India", alts: ["india", "indian", "bharat"] },
  { key: "nepal", label: "🇳🇵 Nepal", alts: ["nepal", "nepali", "nepalese"] },
  { key: "indonesia", label: "🇮🇩 Indonesia", alts: ["indonesia", "indoneshia", "indonesian", "indo"] },
  { key: "bangladesh", label: "🇧🇩 Bangladesh", alts: ["bangladesh", "bangladeshi", "bd"] },
  { key: "pakistan", label: "🇵🇰 Pakistan", alts: ["pakistan", "pakistani", "pak"] },
  { key: "srilanka", label: "🇱🇰 Sri Lanka", alts: ["srilanka", "srilankan"] },
  { key: "usa", label: "🇺🇸 USA", alts: ["usa", "us", "america", "unitedstates"] },
  { key: "uk", label: "🇬🇧 UK", alts: ["uk", "england", "unitedkingdom", "britain"] },
  { key: "philippines", label: "🇵🇭 Philippines", alts: ["philippines", "philipines", "filipino", "ph"] },
  { key: "vietnam", label: "🇻🇳 Vietnam", alts: ["vietnam", "vietnamese"] },
  { key: "thailand", label: "🇹🇭 Thailand", alts: ["thailand", "thai"] },
  { key: "malaysia", label: "🇲🇾 Malaysia", alts: ["malaysia", "malaysian"] },
  { key: "russia", label: "🇷🇺 Russia", alts: ["russia", "russian"] },
  { key: "brazil", label: "🇧🇷 Brazil", alts: ["brazil", "brazilian"] },
  { key: "uae", label: "🇦🇪 UAE", alts: ["uae", "dubai", "emirates"] },
  { key: "egypt", label: "🇪🇬 Egypt", alts: ["egypt", "egyptian"] },
  { key: "nigeria", label: "🇳🇬 Nigeria", alts: ["nigeria", "nigerian"] },
  { key: "kenya", label: "🇰🇪 Kenya", alts: ["kenya", "kenyan"] },
  { key: "turkey", label: "🇹🇷 Turkey", alts: ["turkey", "turkish"] },
  { key: "myanmar", label: "🇲🇲 Myanmar", alts: ["myanmar", "burma"] },
];

function titleCase(s) {
  return s.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// "indoneshia" → { key: "indonesia", label: "🇮🇩 Indonesia" }; unknown → { key: "south-africa", label: "🌍 South Africa" }
function resolveCountry(rawName) {
  const name = rawName.trim();
  const norm = name.toLowerCase().replace(/[^a-z]/g, "");
  const known = KNOWN_COUNTRIES.find(c => c.alts.includes(norm));
  if (known) return { key: known.key, label: known.label };
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  if (!key) return null;
  return { key, label: "🌍 " + titleCase(name) };
}

// "2 india 40  3 nepal 35" → [{key,label,count,price}, ...]  (quantity, country, price per account)
// Returns null if it can't be read.
function parseStockInput(text) {
  const cleaned = text.replace(/[,;\n]+/g, " ").trim();
  if (!/^\d/.test(cleaned)) return null;
  const re = /(\d+)\s*([^\d]+?)\s*(\d+)(?=\s|$)/g;
  const merged = {};
  let m;
  while ((m = re.exec(cleaned))) {
    const count = parseInt(m[1], 10);
    const price = parseInt(m[3], 10);
    const name = m[2].replace(/[^\p{L}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
    if (!name || count < 1 || count > ADD_STOCK_MAX_QTY || price < 1 || price > 100000) return null;
    const c = resolveCountry(name);
    if (!c) return null;
    if (merged[c.key]) { merged[c.key].count += count; merged[c.key].price = price; }
    else merged[c.key] = { key: c.key, label: c.label, count, price };
  }
  // everything typed must have been understood (no leftover text)
  if (cleaned.replace(/(\d+)\s*([^\d]+?)\s*(\d+)(?=\s|$)/g, "").trim() !== "") return null;
  const list = Object.values(merged);
  return list.length ? list : null;
}

// ─── Escape special Markdown characters in user-supplied text ─────────────────
function escMD(text) {
  if (!text) return "";
  return String(text).replace(/[*`\[]/g, "\\$&");
}

// ─── IN-MEMORY STORE ──────────────────────────────────────────────────────────
let users = {};
let pendingDeposits = {};
let pendingAccountOrders = {};
// stock[type][countryKey] = number of accounts available
let stock = {};
// prices[type][countryKey] = ₹ per account (set by admin when adding stock)
let prices = {};
for (const t of Object.keys(ACCOUNT_TYPES)) { stock[t] = {}; prices[t] = {}; }
let countryLabels = {};       // { countryKey: "🇮🇳 India" }
let adminReplyMap = {};       // { adminMessageId: userChatId } — swipe-reply support messages
let orderMsgMap = {};         // { adminMessageId: orderId }    — swipe-reply order chat messages
let adminCurrentOrder = null; // order that admin's plain messages / keyboard buttons act on
let botOnline = true;
let adminState = {};
let userState = {};

function genOrderId() {
  return "ACC" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

function genTxnId() {
  return "TXN" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

const countryLabel = (key) => countryLabels[key] || key;
const stockCount = (type, country) => (stock[type] && stock[type][country]) || 0;
const typeTotal = (type) => Object.values(stock[type] || {}).reduce((s, n) => s + n, 0);
const totalStock = () => Object.keys(ACCOUNT_TYPES).reduce((s, t) => s + typeTotal(t), 0);
const countriesInStock = (type) => Object.entries(stock[type] || {}).filter(([, n]) => n > 0);

// Price per account for a type+country (falls back to the default in ACCOUNT_TYPES)
const priceOf = (type, country) => (prices[type] && prices[type][country]) || ACCOUNT_TYPES[type].price;

function priceRangeText(type) {
  const list = countriesInStock(type).map(([k]) => priceOf(type, k));
  if (!list.length) return "out of stock";
  const min = Math.min(...list), max = Math.max(...list);
  return min === max ? `₹${min} each` : `₹${min} – ₹${max} each`;
}

function stockSummaryText() {
  let out = "";
  for (const [tk, t] of Object.entries(ACCOUNT_TYPES)) {
    out += `${t.label} (total ${typeTotal(tk)})\n`;
    const list = countriesInStock(tk);
    if (!list.length) out += `   — out of stock —\n`;
    for (const [ck, n] of list) out += `   ${countryLabel(ck)}: ${n} — ₹${priceOf(tk, ck)} each\n`;
    out += "\n";
  }
  return out.trimEnd();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const isAdmin = (id) => id === ADMIN_ID;

function registerUser(msg, referredBy = null) {
  const id = msg.chat.id;
  if (!users[id]) {
    users[id] = {
      name: `${msg.from.first_name} ${msg.from.last_name || ""}`.trim(),
      username: msg.from.username || "N/A",
      status: "idle",
      balance: 0,
      hasDeposited: false,
      referredBy: referredBy,
      referRewardPaid: false, // true once THIS user's first order made their referrer's count go up
      referCount: 0,          // valid referrals this user has brought
      freeClaimed: 0,         // free accounts this user already claimed
    };
  }
}

function dname(chatId) {
  const u = users[chatId];
  if (!u) return String(chatId);
  return u.username !== "N/A" ? `@${escMD(u.username)}` : escMD(u.name);
}

function tapCopy(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

const availableFree = (u) =>
  Math.max(0, Math.floor((u.referCount || 0) / REFERRALS_FOR_FREE) - (u.freeClaimed || 0));

// ─── MENUS ────────────────────────────────────────────────────────────────────
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "👤 Profile" }, { text: "💰 Deposit" }, { text: "Stock" }],
        [{ text: "🛒 Buy Account" }],
        [{ text: "🤝 Refer & Earn" }, { text: "🆘 Support" }],
      ],
      resize_keyboard: true,
      persistent: true,
    },
  };
}

function adminMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "📢 Broadcast" }, { text: "📊 Bot Status" }],
        [{ text: "👤 MSG User" }, { text: botOnline ? "🔴 Bot OFF" : "🟢 Bot ON" }, { text: "👥 All Users" }],
        [{ text: "📦 Add Stock" }, { text: "💬 Active Orders" }],
        [{ text: "🔙 User Menu" }],
      ],
      resize_keyboard: true,
    },
  };
}

// Keyboard shown to admin while an order conversation is running
function chatKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "✅ Order Done" }, { text: "❌ Cancel Order" }],
        [{ text: "🔙 Admin Menu" }],
      ],
      resize_keyboard: true,
      persistent: true,
    },
  };
}

// chat keyboard while any order chat is open, normal admin menu otherwise
const adminKb = () => (activeOrders().length ? chatKeyboard() : adminMenu());

// Texts that are menu buttons — these must never be relayed into an order chat.
const MENU_TEXTS = new Set([
  "👤 Profile", "💰 Deposit", "Stock", "🛒 Buy Account", "🤝 Refer & Earn", "🆘 Support",
  "📢 Broadcast", "📊 Bot Status", "👤 MSG User", "🔴 Bot OFF", "🟢 Bot ON", "👥 All Users",
  "📦 Add Stock", "💬 Active Orders", "🔙 User Menu",
  "✅ Order Done", "❌ Cancel Order", "🔙 Admin Menu",
  "❌ Cancel", "❌ Cancel Deposit", "❌ Cancel Purchase",
]);

const cancelKb = (label = "❌ Cancel") => ({
  reply_markup: {
    keyboard: [[{ text: label }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
});

// ─── KEYBOARDS: TYPE / COUNTRY / QUANTITY ───────────────────────────────────
function accountTypeKeyboard() {
  const row = Object.entries(ACCOUNT_TYPES).map(([k, t]) => ({ text: t.label, callback_data: `buyacc_type_${k}` }));
  return {
    reply_markup: {
      inline_keyboard: [row, [{ text: "❌ Cancel", callback_data: "buyacc_cancel" }]],
    },
  };
}

function accountTypeText() {
  return (
    `🛒 Buy Account\n\n` +
    `Which type of account do you want?\n\n` +
    Object.entries(ACCOUNT_TYPES)
      .map(([k, t]) => `${t.label} — ${priceRangeText(k)} (In stock: ${typeTotal(k)})`)
      .join("\n")
  );
}

// Country buttons are built automatically from what is currently in stock for this type.
// prefix + countryKey = callback_data
function countryKeyboard(prefix, accType, cancelData, showPrice = true) {
  const rows = [];
  let row = [];
  for (const [key, n] of countriesInStock(accType)) {
    const label = showPrice
      ? `${countryLabel(key)} • ₹${priceOf(accType, key)} (${n})`
      : `${countryLabel(key)} (${n})`;
    row.push({ text: label, callback_data: `${prefix}${key}` });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: "❌ Cancel", callback_data: cancelData }]);
  return { inline_keyboard: rows };
}

function buyAccountQtyKeyboard(qty) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➖", callback_data: "buyacc_minus" },
          { text: `${qty} Account${qty > 1 ? "s" : ""}`, callback_data: "noop" },
          { text: "➕", callback_data: "buyacc_plus" },
        ],
        [
          { text: "✅ Confirm", callback_data: "buyacc_confirm" },
          { text: "❌ Cancel", callback_data: "buyacc_cancel" },
        ],
      ],
    },
  };
}

function buyAccountQtyText(chatId, accType, country, qty) {
  const t = ACCOUNT_TYPES[accType];
  const unit = priceOf(accType, country);
  const total = qty * unit;
  const bal = users[chatId]?.balance || 0;
  let walletNote = "";
  if (bal >= total) walletNote = `\n\n💰 Wallet: ₹${bal} — this will be paid from your wallet automatically.`;
  else if (bal > 0) walletNote = `\n\n💰 Wallet: ₹${bal} (not enough for this order — you'll pay via UPI, or deposit more to use your wallet)`;
  return (
    `🛒 Buy ${t.label} Account (${countryLabel(country)})\n\n` +
    `How many accounts would you like to buy?\n` +
    `In stock: ${stockCount(accType, country)}\n\n` +
    `Price: ₹${unit} per account\n` +
    `Total: ₹${total}` +
    walletNote
  );
}

function send(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, extra).catch(err =>
    console.error(`sendMessage to ${chatId} failed:`, err.message)
  );
}

function sendMD(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra }).catch(err => {
    console.error(`sendMessage(MD) to ${chatId} failed:`, err.message);
    const plain = text.replace(/[`*_\[\]]/g, "");
    return bot.sendMessage(chatId, plain, extra).catch((e) =>
      console.error(`sendMessage(plain fallback) to ${chatId} also failed:`, e.message)
    );
  });
}

// ─── CHANNEL MEMBERSHIP GATE ──────────────────────────────────────────────────
async function isMemberOf(chat, userId) {
  try {
    const member = await bot.getChatMember(chat.id, userId);
    return ["member", "administrator", "creator", "restricted"].includes(member.status);
  } catch (err) {
    console.error(`getChatMember(${chat.id}, ${userId}) failed:`, err.message,
      "— is the bot an admin of that channel and is CHANNEL_ID correct?");
    return false;
  }
}

async function missingChats(userId) {
  const missing = [];
  for (const c of REQUIRED_CHATS) {
    if (!(await isMemberOf(c, userId))) missing.push(c);
  }
  return missing;
}

function sendJoinPrompt(chatId, missing, note = "") {
  const names = missing.map(c => `“${c.name}”`).join(", ");
  return send(chatId,
    `${note}⚠️ You must join our channel ${names} to use this bot.\n` +
    `Nothing will work until you join.\n\n` +
    `Join the channel, then tap "I've Joined".`,
    {
      reply_markup: {
        inline_keyboard: [
          ...missing.map(c => [{ text: `✅ Join ${c.name}`, url: c.link }]),
          [{ text: "▶️ I've Joined — Continue", callback_data: "check_membership" }],
        ],
      },
    });
}

// Returns true if the user may continue; otherwise sends the join prompt and returns false.
async function passesGate(chatId) {
  if (isAdmin(chatId)) return true;
  const missing = await missingChats(chatId);
  if (!missing.length) return true;
  sendJoinPrompt(chatId, missing);
  return false;
}

// ─── ORDER CHAT (user ↔ admin after approval) ─────────────────────────────────
const typeLabelOf = (o) => ACCOUNT_TYPES[o.accType]?.label || o.accType;
const countryLabelOf = (o) => countryLabel(o.country);
const priceTextOf = (o) => (o.isFree ? "FREE 🎁" : `₹${o.price}${o.paidFromWallet ? " (paid from wallet)" : ""}`);

function activeOrderOfUser(chatId) {
  const list = Object.values(pendingAccountOrders).filter(o => o.chatActive && o.chatId === chatId);
  return list.length ? list[list.length - 1] : null;
}

function activeOrders() {
  return Object.values(pendingAccountOrders).filter(o => o.chatActive);
}

// Which order does an admin message/button belong to?
// 1) swipe-reply target  2) the order whose user wrote last  3) the only active order
function resolveAdminOrder(msg) {
  const rid = msg.reply_to_message && orderMsgMap[msg.reply_to_message.message_id];
  if (rid && pendingAccountOrders[rid]?.chatActive) return pendingAccountOrders[rid];
  if (adminCurrentOrder && pendingAccountOrders[adminCurrentOrder]?.chatActive) return pendingAccountOrders[adminCurrentOrder];
  const active = activeOrders();
  return active.length === 1 ? active[0] : null;
}

function orderHeader(order) {
  return (
    `💬 Order ${order.orderId}\n` +
    `User: ${users[order.chatId]?.name || order.chatId} (${order.chatId})\n` +
    `${typeLabelOf(order)} • ${countryLabelOf(order)} • x${order.quantity}\n\n`
  );
}

function relayUserToAdmin(order, msg) {
  adminCurrentOrder = order.orderId;
  const remember = (s) => { if (s) orderMsgMap[s.message_id] = order.orderId; };
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    bot.sendPhoto(ADMIN_ID, fileId, { caption: orderHeader(order) + (msg.caption || ""), ...chatKeyboard() })
      .then(remember).catch(() => { });
  } else if (msg.text) {
    send(ADMIN_ID, orderHeader(order) + msg.text, chatKeyboard()).then(remember);
  }
}

function startOrderChat(order, stockDeducted) {
  order.status = "approved";
  order.chatActive = true;
  order.stockDeducted = stockDeducted;
  adminCurrentOrder = order.orderId;

  const typeLabel = typeLabelOf(order);
  send(order.chatId,
    `✅ Your order has been approved!\n\n` +
    `Order ID: ${order.orderId}\n` +
    `Type: ${typeLabel}\n` +
    `Country: ${countryLabelOf(order)}\n` +
    `Accounts: ${order.quantity}\n` +
    `Amount: ${priceTextOf(order)}\n\n` +
    `💬 You are now connected with admin for this order. Admin will send your account details here — you can also type here and your messages go to admin directly.`,
    mainMenu());

  let adminText =
    `✅ Order ${order.orderId} approved — chat started\n` +
    `User: ${users[order.chatId]?.name || order.chatId} (${order.chatId})\n` +
    `${typeLabel} • ${countryLabelOf(order)} • x${order.quantity} • ${priceTextOf(order)}\n\n`;
  if (!stockDeducted) {
    adminText += `⚠️ Stock count was lower than the order — nothing was deducted.\n\n`;
  }
  adminText +=
    `Type here to message the user. Use the keyboard below: ✅ Order Done / ❌ Cancel Order.\n` +
    `(With several chats open, swipe-reply to a message of the order you mean.)`;
  send(ADMIN_ID, adminText, chatKeyboard())
    .then(s => { if (s) orderMsgMap[s.message_id] = order.orderId; });
}

// Close an order chat from the admin keyboard (Done / Cancel)
function closeOrder(orderId, isDone) {
  const order = pendingAccountOrders[orderId];
  if (!order || !order.chatActive) {
    send(ADMIN_ID, "❌ This order chat is already closed or not found.", adminKb());
    return;
  }
  order.chatActive = false;
  if (adminCurrentOrder === orderId) adminCurrentOrder = null;

  if (isDone) {
    order.status = "completed";
    send(ADMIN_ID, `✅ Order ${orderId} marked as DONE. Chat closed.`, adminKb());
    send(order.chatId,
      `✅ Your order is complete!\n\n` +
      `Order ID: ${orderId}\n` +
      `Thank you for buying from us. 💚`,
      mainMenu());
    processReferral(order);
  } else {
    order.status = "cancelled";
    let extra = "";
    if (order.isFree && users[order.chatId]) {
      users[order.chatId].freeClaimed = Math.max(0, (users[order.chatId].freeClaimed || 0) - 1);
      extra = `\n\nYour free-account credit has been restored.`;
    } else if ((order.paidFromWallet || REFUND_ON_CANCEL) && users[order.chatId] && order.price > 0) {
      users[order.chatId].balance = (users[order.chatId].balance || 0) + order.price;
      extra = `\n\n₹${order.price} has been added to your bot balance.`;
    }
    send(ADMIN_ID, `❌ Order ${orderId} CANCELLED. Chat closed.`, adminKb());
    send(order.chatId,
      `❌ Your order has been cancelled by admin.\n\n` +
      `Order ID: ${orderId}${extra}\n\n` +
      `If you have questions, use 🆘 Support.`,
      mainMenu());
  }
}

// Credit referrer when the referred user's first (paid) order is completed.
function processReferral(order) {
  if (order.isFree) return;
  const buyer = users[order.chatId];
  if (!buyer || !buyer.referredBy || buyer.referRewardPaid) return;
  const ref = users[buyer.referredBy];
  if (!ref) return;
  buyer.referRewardPaid = true;
  ref.referCount = (ref.referCount || 0) + 1;
  const avail = availableFree(ref);
  if (avail > 0 && ref.referCount % REFERRALS_FOR_FREE === 0) {
    send(buyer.referredBy,
      `🎉 ${REFERRALS_FOR_FREE} valid referrals reached!\n` +
      `You earned a FREE account. Open 🤝 Refer & Earn and tap "Claim Free Account".`);
  } else {
    const left = REFERRALS_FOR_FREE - (ref.referCount % REFERRALS_FOR_FREE);
    send(buyer.referredBy,
      `✅ A friend you referred made a purchase!\n` +
      `Valid referrals: ${ref.referCount} • ${left} more for your next free account.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  /start
// ─────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param = match[1]?.trim() || "";
  const referredBy = param && !isNaN(+param) && +param !== chatId ? +param : null;
  registerUser(msg, referredBy);

  if (isAdmin(chatId)) {
    send(chatId, "👑 Welcome Admin!", adminKb());
    return;
  }
  if (!botOnline) { send(chatId, "🔴 Bot is offline for maintenance. Try again later."); return; }

  if (!(await passesGate(chatId))) return;

  send(chatId,
    `Welcome in Mark's Community, ${msg.from.first_name}`,
    mainMenu());
});

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;

  if (!text && !photo) return;
  if (text && text.startsWith("/")) return;

  registerUser(msg);

  // ══════════════════════ ADMIN ══════════════════════════════════════════════
  if (isAdmin(chatId)) {

    // ── SWIPE-REPLY: ORDER CHAT (admin → user) ──────────────────────────────
    if (msg.reply_to_message && orderMsgMap[msg.reply_to_message.message_id] && text && !MENU_TEXTS.has(text)) {
      const order = pendingAccountOrders[orderMsgMap[msg.reply_to_message.message_id]];
      if (order && order.chatActive) {
        adminCurrentOrder = order.orderId;
        send(order.chatId, `👨‍💼 Admin:\n\n${text}`);
        return;
      }
      send(chatId, "❌ That order chat is already closed.", adminKb());
      return;
    }

    // ── SWIPE-REPLY RELAY (support messages) ────────────────────────────────
    if (msg.reply_to_message && adminReplyMap[msg.reply_to_message.message_id] && text && !MENU_TEXTS.has(text)) {
      const targetUserId = adminReplyMap[msg.reply_to_message.message_id];
      if (users[targetUserId]) {
        send(targetUserId, `💬 Message from Admin:\n\n${text}`, mainMenu());
        send(chatId, `✅ Reply sent to ${users[targetUserId]?.name || targetUserId}.`);
      } else {
        send(chatId, `❌ Could not find that user anymore.`);
      }
      return;
    }

    const st = adminState[chatId];

    if (st) {
      if (photo) {
        const fileId = photo[photo.length - 1].file_id;
        const caption = msg.caption || "";

        if (st.action === "broadcast") {
          let n = 0;
          Object.keys(users).forEach(uid => {
            if (+uid !== ADMIN_ID) {
              bot.sendPhoto(uid, fileId, { caption: caption ? `${caption}` : "..." })
                .catch(() => { if (caption) bot.sendMessage(uid, `${caption}`).catch(() => { }); });
              n++;
            }
          });
          delete adminState[chatId];
          send(chatId, `✅ Photo broadcast sent to ${n} users.`, adminKb());
          return;
        }
        if (st.action === "msg_user_photo") {
          bot.sendPhoto(st.targetId, fileId, { caption: caption ? `${caption}` : "...." })
            .then(() => send(chatId, "✅ Photo sent.", adminKb()))
            .catch(() => send(chatId, "❌ Failed to send photo.", adminKb()));
          delete adminState[chatId];
          return;
        }
      }

      if (text === "❌ Cancel") {
        delete adminState[chatId];
        send(chatId, "❌ Cancelled.", adminKb());
        return;
      }

      if (st.action === "broadcast") {
        let n = 0;
        Object.keys(users).forEach(uid => {
          if (+uid !== ADMIN_ID) { bot.sendMessage(uid, `${text}`).catch(() => { }); n++; }
        });
        delete adminState[chatId];
        send(chatId, `✅ Broadcast sent to ${n} users.`, adminKb());
        return;
      }

      if (st.action === "msg_user_id") {
        const tid = +text;
        if (!users[tid]) { send(chatId, `❌ User ${text} not found.`); delete adminState[chatId]; return; }
        adminState[chatId] = { action: "msg_user_text", targetId: tid };
        send(chatId, `Send your message to ${users[tid].name}`, cancelKb());
        return;
      }

      if (st.action === "msg_user_text") {
        bot.sendMessage(st.targetId, `${text}`)
          .then(() => send(chatId, "✅ Message sent.", adminKb()))
          .catch(() => send(chatId, "❌ Failed to send.", adminKb()));
        delete adminState[chatId];
        return;
      }

      // ── ADD STOCK — STEP 2: "2 india 3 nepal 4 indonesia" → PREVIEW + CONFIRM ──
      if (st.action === "add_stock_input") {
        if (!text) { send(chatId, "❌ Please send the stock as text.", cancelKb()); return; }
        const entries = parseStockInput(text);
        if (!entries) {
          send(chatId,
            `❌ I couldn't read that.\n\nSend quantity, country and price per account, like:\n2 india 40\n\n` +
            `Several at once: 2 india 40 3 nepal 35 4 indonesia 30\n` +
            `(quantity 1 – ${ADD_STOCK_MAX_QTY} each) — or tap Cancel.`,
            cancelKb());
          return;
        }
        adminState[chatId] = { action: "add_stock_confirm", type: st.type, entries };
        const total = entries.reduce((s, e) => s + e.count, 0);
        send(chatId,
          `📦 Confirm Stock\n\n` +
          `Type: ${ACCOUNT_TYPES[st.type].label}\n\n` +
          entries.map(e =>
            `${e.label}: +${e.count} @ ₹${e.price} each  (stock → ${stockCount(st.type, e.key) + e.count})` +
            (stockCount(st.type, e.key) > 0 && priceOf(st.type, e.key) !== e.price
              ? `\n   ⚠️ price changes ₹${priceOf(st.type, e.key)} → ₹${e.price} for this country`
              : "")
          ).join("\n") +
          `\n\nTotal adding: ${total}\n\nAdd this to stock?`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Confirm", callback_data: "addstock_confirm" },
                { text: "❌ Cancel", callback_data: "addstock_cancel" },
              ]]
            },
          });
        return;
      }
    }

    // ── Admin menu buttons ──────────────────────────────────────────────────
    if (text === "📢 Broadcast") {
      adminState[chatId] = { action: "broadcast" };
      const n = Object.keys(users).filter(id => +id !== ADMIN_ID).length;
      send(chatId, `Write broadcast to send ${n} users.`, cancelKb());
      return;
    }
    if (text === "👤 MSG User") {
      adminState[chatId] = { action: "msg_user_id" };
      send(chatId, "Enter User ID:", cancelKb());
      return;
    }
    // ── ADD STOCK — STEP 1: CHOOSE TYPE ─────────────────────────────────────
    if (text === "📦 Add Stock") {
      delete adminState[chatId];
      send(chatId,
        `📦 Add Stock\n\nWhich type of accounts do you want to add?\n\n${stockSummaryText()}`,
        {
          reply_markup: {
            inline_keyboard: [
              Object.entries(ACCOUNT_TYPES).map(([k, t]) => ({ text: t.label, callback_data: `addstock_type_${k}` })),
              [{ text: "❌ Cancel", callback_data: "addstock_cancel" }],
            ],
          },
        });
      return;
    }

    // ── ORDER CHAT KEYBOARD BUTTONS ─────────────────────────────────────────
    if (text === "✅ Order Done" || text === "❌ Cancel Order") {
      const order = resolveAdminOrder(msg);
      if (!order) {
        send(chatId,
          activeOrders().length
            ? `⚠️ ${activeOrders().length} order chats are open. Swipe-reply to a message of the order, then press the button again (or tap 💬 Active Orders).`
            : `No active order chat right now.`,
          adminKb());
        return;
      }
      closeOrder(order.orderId, text === "✅ Order Done");
      return;
    }
    if (text === "💬 Active Orders") {
      const list = activeOrders();
      if (!list.length) { send(chatId, "No active order chats right now.", adminMenu()); return; }
      list.forEach(o => {
        send(chatId,
          `💬 Order ${o.orderId}${adminCurrentOrder === o.orderId ? "  ⬅️ current" : ""}\n` +
          `User: ${users[o.chatId]?.name || o.chatId} (${o.chatId})\n` +
          `${typeLabelOf(o)} • ${countryLabelOf(o)} • x${o.quantity} • ${priceTextOf(o)}\n\n` +
          `↩️ Swipe-reply to this message to talk to / close this order.`,
          chatKeyboard()
        ).then(s => { if (s) orderMsgMap[s.message_id] = o.orderId; });
      });
      return;
    }
    if (text === "🔙 Admin Menu") {
      send(chatId, "👑 Admin menu.", adminMenu());
      return;
    }
    if (text === "📊 Bot Status") {
      const totalUsers = Object.keys(users).filter(id => +id !== ADMIN_ID).length;
      const allOrders = Object.values(pendingAccountOrders);
      const pendingOrders = allOrders.filter(o => o.status === "pending").length;
      const activeChats = allOrders.filter(o => o.chatActive).length;
      const soldOrders = allOrders.filter(o => o.status === "approved" || o.status === "completed");
      const totalAccountsSold = soldOrders.reduce((s, o) => s + o.quantity, 0);
      const totalRevenue = soldOrders.reduce((s, o) => s + o.price, 0);
      const pendingDepositsCount = Object.values(pendingDeposits).filter(d => d.status === "pending").length;

      const since = Date.now() - 24 * 60 * 60 * 1000;
      const orders24h = soldOrders.filter(o => o.timestamp && new Date(o.timestamp).getTime() >= since);
      const revenue24h = orders24h.reduce((s, o) => s + o.price, 0);
      const accounts24h = orders24h.reduce((s, o) => s + o.quantity, 0);

      send(chatId,
        `📊 Bot Status\n\n` +
        `Status: ${botOnline ? "🟢 Online" : "🔴 Offline"}\n` +
        `Total Users: ${totalUsers}\n` +
        `📦 Stock Available: ${totalStock()}\n` +
        `${stockSummaryText()}\n\n` +
        `Pending Orders: ${pendingOrders}\n` +
        `Active Order Chats: ${activeChats}\n` +
        `Pending Deposits: ${pendingDepositsCount}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📈 All-Time\n` +
        `Accounts Sold: ${totalAccountsSold}\n` +
        `Total Revenue: ₹${totalRevenue}\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `⏰ Last 24 Hours\n` +
        `Accounts Sold: ${accounts24h}\n` +
        `Revenue: ₹${revenue24h}`);
      return;
    }
    if (text === "🔴 Bot OFF" || text === "🟢 Bot ON") {
      botOnline = !botOnline;
      send(chatId, botOnline ? "🟢 Bot is now ONLINE!" : "🔴 Bot is now OFFLINE!", adminMenu());
      return;
    }
    if (text === "👥 All Users") {
      const all = Object.keys(users).filter(id => +id !== ADMIN_ID);
      if (!all.length) { send(chatId, "No users yet."); return; }
      const chunks = [];
      for (let i = 0; i < all.length; i += 50) chunks.push(all.slice(i, i + 50));
      chunks.forEach((ch, idx) => {
        let m = idx === 0 ? `Total Users: ${all.length}:\n\n` : `Continued...\n\n`;
        ch.forEach(id => { const u = users[id]; m += `ID: ${id} | ${u.name} | ₹${u.balance || 0} | ${u.status}\n`; });
        send(chatId, m);
      });
      return;
    }
    if (text === "🔙 User Menu") {
      send(chatId, "Switched to User Menu.", mainMenu());
      return;
    }

    // ── PLAIN ADMIN TEXT → ORDER CHAT ───────────────────────────────────────
    if (text && !MENU_TEXTS.has(text) && !st) {
      const order = resolveAdminOrder(msg);
      if (order) {
        adminCurrentOrder = order.orderId;
        send(order.chatId, `👨‍💼 Admin:\n\n${text}`);
        return;
      }
      if (activeOrders().length > 1) {
        send(chatId,
          `⚠️ ${activeOrders().length} order chats are open. Swipe-reply to a message of the order you want to answer.\n` +
          `Tap 💬 Active Orders to see them all.`,
          chatKeyboard());
        return;
      }
    }
  }

  // ══════════════════════ USER ═══════════════════════════════════════════════
  if (!botOnline) { send(chatId, "🔴 Bot is offline for maintenance."); return; }

  // ── CHANNEL GATE: nothing works until the user has joined ─────────────────
  if (!isAdmin(chatId) && text) {
    if (!(await passesGate(chatId))) return;
  }

  // ── User state machine ────────────────────────────────────────────────────
  const st = userState[chatId];
  if (st) {
    // ── MESSAGE ADMIN ────────────────────────────────────────────────────
    if (st.action === "messaging_admin") {
      if (text === "❌ Cancel") {
        delete userState[chatId];
        send(chatId, "❌ Cancelled.", mainMenu());
        return;
      }
      if (!text) {
        send(chatId, "📝 Please send a text message.");
        return;
      }
      delete userState[chatId];
      const u = users[chatId] || {};
      bot.sendMessage(ADMIN_ID,
        `✉️ New message from a user\n\n` +
        `Name: ${u.name || "N/A"}\n` +
        `Username: @${u.username || "N/A"}\n` +
        `ID: ${chatId}\n\n` +
        `Message:\n${text}\n\n` +
        `↩️ Swipe / press-hold and reply to THIS message to respond directly.`
      ).then(sentMsg => {
        adminReplyMap[sentMsg.message_id] = chatId;
      }).catch(() => { });
      send(chatId, "✅ Your message has been sent to admin. They'll reply here soon.", mainMenu());
      return;
    }

    // ── DEPOSIT: AMOUNT STAGE ───────────────────────────────────────────────
    if (st.action === "deposit_amount") {
      if (!text) return;
      if (text === "❌ Cancel") {
        delete userState[chatId];
        send(chatId, "❌ Deposit cancelled.", mainMenu());
        return;
      }
      if (!/^\d+$/.test(text.trim())) {
        send(chatId, "❌ Please enter a valid amount in numbers only (e.g. 100), or tap Cancel.", cancelKb());
        return;
      }
      const amount = parseInt(text.trim(), 10);
      if (amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
        send(chatId, `❌ Amount must be between ₹${MIN_DEPOSIT} and ₹${MAX_DEPOSIT}.`, cancelKb());
        return;
      }
      const existing = Object.values(pendingDeposits).find(d => d.chatId === chatId && d.status === "pending");
      if (existing) {
        delete userState[chatId];
        send(chatId, `⏳ You already have a pending deposit: ${existing.txnId} | ₹${existing.amount}\nPlease wait for admin to verify it.`, mainMenu());
        return;
      }
      userState[chatId] = { action: "deposit_qr", amount };
      bot.sendPhoto(chatId, PAYMENT_QR, {
        caption:
          `💰 Deposit ₹${amount}\n\n` +
          `Amount to Pay: ₹${amount}\n\n` +
          `UPI ID: ${tapCopy(UPI_ID)}\n\n` +
          `📷 After payment, tap "I Have Paid" and upload the screenshot.`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ I Have Paid", callback_data: "dep_paid" },
            { text: "❌ Cancel", callback_data: "dep_cancel_qr" },
          ]]
        },
      }).catch(() => { });
      return;
    }

    // ── DEPOSIT: SCREENSHOT STAGE (text received instead of photo) ──────────
    if (st.action === "deposit_screenshot") {
      if (!text) return; // photo is handled by the photo handler
      if (text === "❌ Cancel Deposit") {
        delete userState[chatId];
        send(chatId, "❌ Deposit cancelled.", mainMenu());
        return;
      }
      send(chatId, "📸 Please send a screenshot image as proof, not text.");
      return;
    }

    // ── BUY ACCOUNT: SCREENSHOT STAGE (text received instead of photo) ──────
    if (st.action === "buy_account_screenshot") {
      if (!text) return; // photo is handled by the photo handler
      if (text === "❌ Cancel Purchase") {
        delete userState[chatId];
        send(chatId, "❌ Purchase cancelled.", mainMenu());
        return;
      }
      send(chatId, "📸 Please send a screenshot image as proof, not text.");
      return;
    }
  }

  if (!text) return;

  if (text === "👤 Profile") {
    const u = users[chatId] || {};
    const pd = Object.values(pendingDeposits).find(d => d.chatId === chatId && d.status === "pending");
    sendMD(chatId,
      `👤 Your Profile\n\n` +
      `ID: ${tapCopy(chatId)}\n` +
      `Name: ${u.name || "N/A"}\n` +
      `Balance: ₹${u.balance || 0}\n` +
      `Valid Referrals: ${u.referCount || 0}\n` +
      `Free Accounts Available: ${availableFree(u)}` +
      (pd ? `\n\nPending Deposit: ₹${pd.amount} (TXN: ${tapCopy(pd.txnId)})` : ""),
      mainMenu());
    return;
  }

  if (text === "Stock") {
    send(chatId,
      `📦 Stock Status\n\n` +
      `${stockSummaryText()}\n\n` +
      (totalStock() > 0
        ? `Tap "🛒 Buy Account" to purchase now!`
        : `Currently out of stock. Please check back later.`),
      mainMenu());
    return;
  }

  // ── DEPOSIT: START ────────────────────────────────────────────────────────
  if (text === "💰 Deposit") {
    const existing = Object.values(pendingDeposits).find(d => d.chatId === chatId && d.status === "pending");
    if (existing) {
      send(chatId, `⏳ You already have a pending deposit: ${existing.txnId} | ₹${existing.amount}\nPlease wait for admin to verify it.`, mainMenu());
      return;
    }
    userState[chatId] = { action: "deposit_amount" };
    send(chatId,
      `💰 Deposit\n\nEnter the amount you want to deposit (₹${MIN_DEPOSIT} – ₹${MAX_DEPOSIT}):`,
      cancelKb());
    return;
  }

  // ── BUY ACCOUNT: START (CHOOSE TYPE) ──────────────────────────────────────
  if (text === "🛒 Buy Account") {
    userState[chatId] = { action: "buy_account_type" };
    send(chatId, accountTypeText(), accountTypeKeyboard());
    return;
  }

  if (text === "🤝 Refer & Earn") {
    const u = users[chatId] || {};
    const count = u.referCount || 0;
    const avail = availableFree(u);
    const toNext = REFERRALS_FOR_FREE - (count % REFERRALS_FOR_FREE);
    send(chatId,
      `🤝 Refer & Earn\n\n` +
      `Your Referral Link:\n` +
      `https://t.me/TgStoreBot?start=${chatId}\n\n` +
      `🎁 Get 1 FREE WhatsApp/Telegram account for every ${REFERRALS_FOR_FREE} valid referrals.\n` +
      `A referral is valid when your friend buys at least one account.\n\n` +
      `✅ Valid referrals: ${count}\n` +
      `⏳ ${toNext} more for your next free account\n` +
      `🎁 Free accounts available: ${avail}`,
      avail > 0
        ? { reply_markup: { inline_keyboard: [[{ text: `🎁 Claim Free Account (${avail})`, callback_data: "refclaim_start" }]] } }
        : {});
    return;
  }

  if (text === "🆘 Support") {
    send(chatId, "🆘 Support\nChoose an option:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📞 Contact Admin", url: "https://t.me/Mark41_001" }],
          [{ text: "✉️ Message Admin (in bot)", callback_data: "msg_admin_start" }],
        ]
      },
    });
    return;
  }

  // ── ORDER CHAT: any other text from a user with an active order → admin ────
  if (!isAdmin(chatId) && !MENU_TEXTS.has(text)) {
    const order = activeOrderOfUser(chatId);
    if (order) {
      relayUserToAdmin(order, msg);
      return;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CALLBACK QUERY HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("callback_query", async query => {
  const data = query.data;
  const msgId = query.message.message_id;
  const isGroupCallback = query.message.chat.type !== "private";
  const chatId = isGroupCallback ? query.from.id : query.message.chat.id;

  bot.answerCallbackQuery(query.id).catch(() => { });

  if (data === "noop") {
    return;
  }

  // ── CHANNEL GATE (everything except the "I've Joined" button) ─────────────
  if (data !== "check_membership" && !isAdmin(chatId)) {
    if (!(await passesGate(chatId))) return;
  }

  if (data === "check_membership") {
    const missing = await missingChats(chatId);
    if (!missing.length) {
      bot.deleteMessage(chatId, msgId).catch(() => { });
      send(chatId, `🎲 Welcome in Marks Community !!`, mainMenu());
    } else {
      bot.deleteMessage(chatId, msgId).catch(() => { });
      sendJoinPrompt(chatId, missing, "❌ You haven't joined yet!\n\n");
    }
    return;
  }

  // ── MESSAGE ADMIN: START ────────────────────────────────────────────────
  if (data === "msg_admin_start") {
    userState[chatId] = { action: "messaging_admin" };
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId, "✉️ Type your message for admin below. It will be forwarded directly.", cancelKb("❌ Cancel"));
    return;
  }

  // ══════════════════ ADMIN: ADD STOCK FLOW ══════════════════════════════════
  // Step 1 → pick type → Step 2 → type "2 india 3 nepal 4 indonesia"
  if (data.startsWith("addstock_type_")) {
    if (!isAdmin(chatId)) return;
    const type = data.replace("addstock_type_", "");
    if (!ACCOUNT_TYPES[type]) return;
    adminState[chatId] = { action: "add_stock_input", type };
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `📦 Add ${ACCOUNT_TYPES[type].label} Stock\n\n` +
      `Send quantity, country and price per account. Example:\n\n` +
      `2 india 40\n\n` +
      `Several at once:\n` +
      `2 india 40 3 nepal 35 4 indonesia 30\n\n` +
      `Buyers automatically get a button (with the price) for each country in stock. ` +
      `The price you send becomes the price for that country.\n\n` +
      `Current stock:\n` +
      (countriesInStock(type).map(([k, n]) => `${countryLabel(k)}: ${n} @ ₹${priceOf(type, k)}`).join("\n") || "— none —"),
      cancelKb());
    return;
  }

  // Step 3 → confirm and add
  if (data === "addstock_confirm") {
    if (!isAdmin(chatId)) return;
    const st = adminState[chatId];
    if (!st || st.action !== "add_stock_confirm") return;
    for (const e of st.entries) {
      countryLabels[e.key] = e.label;
      stock[st.type][e.key] = stockCount(st.type, e.key) + e.count;
      prices[st.type][e.key] = e.price;
    }
    const added = st.entries.reduce((s, e) => s + e.count, 0);
    const label = ACCOUNT_TYPES[st.type].label;
    const type = st.type;
    delete adminState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `✅ Added ${added} ${label} account${added > 1 ? "s" : ""} to stock.\n\n` +
      countriesInStock(type).map(([k, n]) => `${countryLabel(k)}: ${n} @ ₹${priceOf(type, k)}`).join("\n") +
      `\n\n📦 ${label} total: ${typeTotal(type)}\n📦 All stock: ${totalStock()}`,
      adminKb());
    return;
  }

  if (data === "addstock_cancel") {
    if (!isAdmin(chatId)) return;
    delete adminState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId, "❌ Add stock cancelled.", adminKb());
    return;
  }

  // ══════════════════ DEPOSIT FLOW ═══════════════════════════════════════════
  if (data === "dep_cancel_qr") {
    delete userState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId, "❌ Deposit cancelled.", mainMenu());
    return;
  }

  if (data === "dep_paid") {
    const st = userState[chatId];
    if (!st || st.action !== "deposit_qr") return;
    bot.deleteMessage(chatId, msgId).catch(() => { });
    userState[chatId] = { action: "deposit_screenshot", amount: st.amount };
    send(chatId,
      `📷 Please upload the payment screenshot.\n\n⚠ Screenshot must contain the UTR number.`,
      cancelKb("❌ Cancel Deposit"));
    return;
  }

  // ── DEPOSIT: ADMIN APPROVE / REJECT ─────────────────────────────────────────
  if (data.startsWith("dep_approve_") || data.startsWith("dep_reject_")) {
    if (!isAdmin(chatId)) return;
    const isApprove = data.startsWith("dep_approve_");
    const txnId = data.replace(isApprove ? "dep_approve_" : "dep_reject_", "");
    const dep = pendingDeposits[txnId];
    if (!dep || dep.status !== "pending") {
      send(chatId, "❌ Deposit not found or already processed.");
      return;
    }
    const u = users[dep.chatId];

    if (!isApprove) {
      dep.status = "rejected";
      send(chatId, `❌ Deposit ${txnId} rejected.`);
      send(dep.chatId,
        `❌ Your deposit request was rejected.\n\n` +
        `TXN ID: ${txnId}\nAmount: ₹${dep.amount}\n\n` +
        `Please contact support if you believe this is a mistake.`,
        mainMenu());
      return;
    }

    dep.status = "approved";
    if (u) {
      u.balance = (u.balance || 0) + dep.amount;
      u.hasDeposited = true;
    }
    send(chatId, `✅ Deposit ${txnId} approved. ₹${dep.amount} credited to ${u?.name || dep.chatId}.`);
    send(dep.chatId,
      `✅ Your deposit has been approved!\n\n` +
      `TXN ID: ${txnId}\n` +
      `Amount Added: ₹${dep.amount}\n` +
      `New Balance: ₹${u?.balance ?? dep.amount}`,
      mainMenu());
    return;
  }

  // ══════════════════ BUY ACCOUNT FLOW ═══════════════════════════════════════
  // ── TYPE SELECTED → COUNTRY (buttons auto-built from stock) ─────────────────
  if (data.startsWith("buyacc_type_")) {
    const accType = data.replace("buyacc_type_", "");
    if (!ACCOUNT_TYPES[accType]) return;
    if (typeTotal(accType) === 0) {
      send(chatId, `❌ ${ACCOUNT_TYPES[accType].label} accounts are out of stock right now. Please check back later.`);
      return;
    }
    userState[chatId] = { action: "buy_account_country", accType };
    bot.editMessageText(
      `🛒 Buy ${ACCOUNT_TYPES[accType].label} Account\n\nSelect the country (number = in stock):`,
      {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: countryKeyboard("buyacc_country_", accType, "buyacc_cancel"),
      }
    ).catch(() => { });
    return;
  }

  // ── COUNTRY SELECTED → QUANTITY ─────────────────────────────────────────────
  if (data.startsWith("buyacc_country_")) {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_country") return;
    const country = data.replace("buyacc_country_", "");
    if (stockCount(st.accType, country) < 1) {
      send(chatId, `❌ That country is out of stock now. Please choose another.`);
      return;
    }
    userState[chatId] = { action: "buy_account_qty", accType: st.accType, country, quantity: 1 };
    bot.editMessageText(buyAccountQtyText(chatId, st.accType, country, 1), {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: buyAccountQtyKeyboard(1).reply_markup,
    }).catch(() => { });
    return;
  }

  // ── QUANTITY STEPPER ────────────────────────────────────────────────────────
  if (data === "buyacc_minus" || data === "buyacc_plus") {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_qty") return;
    const maxQty = Math.max(1, Math.min(ACCOUNT_MAX_QTY, stockCount(st.accType, st.country)));
    let qty = st.quantity;
    qty = data === "buyacc_plus" ? Math.min(maxQty, qty + 1) : Math.max(1, qty - 1);
    if (qty === st.quantity) return;
    st.quantity = qty;
    bot.editMessageText(buyAccountQtyText(chatId, st.accType, st.country, qty), {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: buyAccountQtyKeyboard(qty).reply_markup,
    }).catch(() => { });
    return;
  }

  // ── CANCEL (TYPE / COUNTRY / QUANTITY STAGE) ────────────────────────────────
  if (data === "buyacc_cancel") {
    delete userState[chatId];
    bot.editMessageText("❌ Purchase cancelled.", { chat_id: chatId, message_id: msgId }).catch(() => { });
    send(chatId, "You can start a new purchase anytime from the menu.", mainMenu());
    return;
  }

  // ── CONFIRM QUANTITY → SHOW QR ──────────────────────────────────────────────
  if (data === "buyacc_confirm") {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_qty") return;
    const { accType, country, quantity: qty } = st;
    if (stockCount(accType, country) < qty) {
      send(chatId, `❌ Not enough stock anymore. Please start again.`, mainMenu());
      delete userState[chatId];
      bot.deleteMessage(chatId, msgId).catch(() => { });
      return;
    }
    const t = ACCOUNT_TYPES[accType];
    const price = qty * priceOf(accType, country);
    bot.deleteMessage(chatId, msgId).catch(() => { });

    // ── WALLET PAYMENT: enough balance → deduct instantly, skip QR, start order chat ──
    const buyer = users[chatId];
    if (buyer && (buyer.balance || 0) >= price) {
      buyer.balance -= price;
      stock[accType][country] -= qty;
      const orderId = genOrderId();
      const order = {
        orderId, chatId, accType, country, quantity: qty, price,
        isFree: false, paidFromWallet: true,
        status: "pending", chatActive: false, timestamp: new Date(),
      };
      pendingAccountOrders[orderId] = order;
      delete userState[chatId];
      send(chatId, `💰 ₹${price} deducted from your wallet.\nRemaining balance: ₹${buyer.balance}`);
      startOrderChat(order, true);
      return;
    }

    userState[chatId] = { action: "buy_account_qr", accType, country, quantity: qty, price };
    bot.sendPhoto(chatId, PAYMENT_QR, {
      caption:
        `🛒 Buy ${qty} ${t.label} (${countryLabel(country)}) Account${qty > 1 ? "s" : ""}\n\n` +
        `Amount to Pay: ₹${price}\n\n` +
        `UPI ID: ${tapCopy(UPI_ID)}\n\n` +
        `📷 After payment, tap "I Have Paid" and upload the screenshot.`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ I Have Paid", callback_data: "buyacc_paid" },
          { text: "❌ Cancel", callback_data: "buyacc_cancel_qr" },
        ]]
      },
    }).catch(() => { });
    return;
  }

  // ── CANCEL AT QR STAGE ──────────────────────────────────────────────────────
  if (data === "buyacc_cancel_qr") {
    delete userState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId, "❌ Purchase cancelled.", mainMenu());
    return;
  }

  // ── "I HAVE PAID" → ASK FOR SCREENSHOT ──────────────────────────────────────
  if (data === "buyacc_paid") {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_qr") return;
    bot.deleteMessage(chatId, msgId).catch(() => { });
    userState[chatId] = {
      action: "buy_account_screenshot",
      accType: st.accType, country: st.country, quantity: st.quantity, price: st.price,
    };
    send(chatId,
      `📷 Please upload the payment screenshot.\n\n⚠ Screenshot must contain the UTR number.`,
      cancelKb("❌ Cancel Purchase"));
    return;
  }

  // ── ADMIN APPROVE / REJECT ORDER ────────────────────────────────────────────
  if (data.startsWith("accord_approve_") || data.startsWith("accord_reject_")) {
    if (!isAdmin(chatId)) return;
    const isApprove = data.startsWith("accord_approve_");
    const orderId = data.replace(isApprove ? "accord_approve_" : "accord_reject_", "");
    const order = pendingAccountOrders[orderId];
    if (!order || order.status !== "pending") {
      send(chatId, "❌ Order not found or already processed.");
      return;
    }

    if (!isApprove) {
      order.status = "rejected";
      // Free-claim rejected → give the credit back
      if (order.isFree && users[order.chatId]) {
        users[order.chatId].freeClaimed = Math.max(0, (users[order.chatId].freeClaimed || 0) - 1);
      }
      send(chatId, `❌ Order ${orderId} rejected.`);
      send(order.chatId,
        `❌ Your account ${order.isFree ? "free claim" : "purchase"} request was rejected.\n\n` +
        `Order ID: ${orderId}\n\n` +
        (order.isFree ? `Your free-account credit has been restored.\n\n` : "") +
        `Please contact support if you believe this is a mistake.`,
        mainMenu());
      return;
    }

    // Approve → deduct the stock count, then START ORDER CHAT (admin sends the details in chat)
    let deducted = false;
    if (stockCount(order.accType, order.country) >= order.quantity) {
      stock[order.accType][order.country] -= order.quantity;
      deducted = true;
    }
    startOrderChat(order, deducted);
    return;
  }

  // ══════════════════ REFERRAL: CLAIM FREE ACCOUNT ═══════════════════════════
  if (data === "refclaim_start") {
    const u = users[chatId];
    if (!u || availableFree(u) < 1) {
      send(chatId, `❌ You have no free account available yet. Get ${REFERRALS_FOR_FREE} valid referrals first.`);
      return;
    }
    send(chatId, `🎁 Claim Free Account\n\nWhich type do you want?`, {
      reply_markup: {
        inline_keyboard: [
          Object.entries(ACCOUNT_TYPES).map(([k, t]) => ({ text: t.label, callback_data: `refclaim_type_${k}` })),
          [{ text: "❌ Cancel", callback_data: "refclaim_cancel" }],
        ],
      },
    });
    bot.deleteMessage(chatId, msgId).catch(() => { });
    return;
  }

  if (data === "refclaim_cancel") {
    bot.deleteMessage(chatId, msgId).catch(() => { });
    return;
  }

  if (data.startsWith("refclaim_type_")) {
    const accType = data.replace("refclaim_type_", "");
    if (!ACCOUNT_TYPES[accType]) return;
    if (typeTotal(accType) === 0) {
      send(chatId, `❌ ${ACCOUNT_TYPES[accType].label} is out of stock right now. Try another type or come back later.`);
      return;
    }
    bot.editMessageText(
      `🎁 Free ${ACCOUNT_TYPES[accType].label} Account\n\nSelect the country:`,
      {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: countryKeyboard(`refclaim_country_${accType}_`, accType, "refclaim_cancel", false),
      }
    ).catch(() => { });
    return;
  }

  if (data.startsWith("refclaim_country_")) {
    const [, , accType, country] = data.split("_");
    const u = users[chatId];
    if (!ACCOUNT_TYPES[accType] || !country) return;
    if (!u || availableFree(u) < 1) {
      send(chatId, `❌ You have no free account available.`);
      return;
    }
    if (stockCount(accType, country) < 1) {
      send(chatId, `❌ That country is out of stock now. Choose another.`);
      return;
    }
    u.freeClaimed = (u.freeClaimed || 0) + 1; // reserve the credit now
    const orderId = genOrderId();
    pendingAccountOrders[orderId] = {
      orderId, chatId, accType, country, quantity: 1, price: 0, isFree: true,
      status: "pending", chatActive: false, timestamp: new Date(),
    };
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `🎁 Free account request sent!\n\n` +
      `Order ID: ${orderId}\n` +
      `Type: ${ACCOUNT_TYPES[accType].label}\n` +
      `Country: ${countryLabel(country)}\n\n` +
      `Admin will approve it shortly and chat with you here.`,
      mainMenu());
    send(ADMIN_ID,
      `🎁 FREE Account Claim (referral reward)\n\n` +
      `Order ID: ${orderId}\n` +
      `User: ${u.name || "Unknown"} (${chatId})\n` +
      `Username: @${u.username || "N/A"}\n` +
      `Type: ${ACCOUNT_TYPES[accType].label}\n` +
      `Country: ${countryLabel(country)}\n` +
      `Valid referrals: ${u.referCount}\n` +
      `Time: ${new Date().toLocaleString("en-IN")}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: `accord_approve_${orderId}` },
            { text: "❌ Reject", callback_data: `accord_reject_${orderId}` },
          ]]
        },
      });
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PHOTO HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("photo", async msg => {
  const chatId = msg.chat.id;

  if (isAdmin(chatId)) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    // ── SWIPE-REPLY / CURRENT ORDER: photo to user in order chat ──────────
    const isReplyToSupport = msg.reply_to_message && adminReplyMap[msg.reply_to_message.message_id];
    if (!isReplyToSupport && !adminState[chatId]) {
      const order = resolveAdminOrder(msg);
      if (order) {
        adminCurrentOrder = order.orderId;
        bot.sendPhoto(order.chatId, fileId, {
          caption: msg.caption ? `👨‍💼 Admin:\n\n${msg.caption}` : "👨‍💼 Admin",
        }).then(() => send(chatId, `✅ Photo sent to order ${order.orderId}.`))
          .catch(() => send(chatId, "❌ Failed to send photo."));
        return;
      }
    }

    // ── SWIPE-REPLY RELAY WITH A PHOTO (support messages) ─────────────────
    if (isReplyToSupport) {
      const targetUserId = adminReplyMap[msg.reply_to_message.message_id];
      bot.sendPhoto(targetUserId, fileId, {
        caption: msg.caption ? `💬 Message from Admin:\n\n${msg.caption}` : "💬 Message from Admin",
      }).then(() => send(chatId, `✅ Photo reply sent to ${users[targetUserId]?.name || targetUserId}.`))
        .catch(() => send(chatId, "❌ Failed to send photo reply."));
    }
    return;
  }

  if (!botOnline) return;
  if (!(await passesGate(chatId))) return;

  const st = userState[chatId];

  // ── No payment/screenshot stage → maybe an order-chat photo for admin ──────
  if (!st || (st.action !== "deposit_screenshot" && st.action !== "buy_account_screenshot")) {
    const order = activeOrderOfUser(chatId);
    if (order) relayUserToAdmin(order, msg);
    return;
  }

  // ── DEPOSIT: SCREENSHOT RECEIVED → SEND TO ADMIN ────────────────────────────
  if (st.action === "deposit_screenshot") {
    const ep = Object.values(pendingDeposits).find(d => d.chatId === chatId && d.status === "pending");
    if (ep) {
      send(chatId, `Deposit already pending: ${ep.txnId} | ₹${ep.amount}\nWait for admin.`, mainMenu());
      delete userState[chatId];
      return;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const txnId = genTxnId();
    pendingDeposits[txnId] = {
      txnId, chatId, amount: st.amount, screenshotFileId: fileId, status: "pending", timestamp: new Date(),
    };
    delete userState[chatId];

    send(chatId,
      `📸 Screenshot Received!\n\nTXN ID: ${txnId}\nAmount: ₹${st.amount}\n\nAdmin is verifying. You will be notified.`,
      mainMenu());

    bot.sendPhoto(ADMIN_ID, fileId, {
      caption:
        `Deposit Request!\n\n` +
        `TXN: ${txnId}\n` +
        `User: ${users[chatId]?.name || "Unknown"} (${chatId})\n` +
        `Username: @${users[chatId]?.username || "N/A"}\n` +
        `Amount: ₹${st.amount}\n` +
        `Time: ${new Date().toLocaleString("en-IN")}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `dep_approve_${txnId}` },
          { text: "❌ Reject", callback_data: `dep_reject_${txnId}` },
        ]]
      },
    }).catch(() => {
      bot.sendMessage(ADMIN_ID,
        `New Deposit!\nTXN: ${txnId}\nUser: ${users[chatId]?.name} (${chatId})\nAmount: ₹${st.amount}\nScreenshot forward failed.`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `dep_approve_${txnId}` }, { text: "❌ Reject", callback_data: `dep_reject_${txnId}` }]] } }
      ).catch(() => { });
    });
    return;
  }

  // ── BUY ACCOUNT: SCREENSHOT RECEIVED → SEND TO ADMIN ────────────────────────
  if (st.action === "buy_account_screenshot") {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const orderId = genOrderId();
    const typeLabel = ACCOUNT_TYPES[st.accType]?.label || st.accType;
    const cLabel = countryLabel(st.country);
    pendingAccountOrders[orderId] = {
      orderId,
      chatId,
      accType: st.accType,
      country: st.country,
      quantity: st.quantity,
      price: st.price,
      isFree: false,
      screenshotFileId: fileId,
      status: "pending",
      chatActive: false,
      timestamp: new Date(),
    };
    delete userState[chatId];

    send(chatId,
      `📸 Screenshot Received!\n\n` +
      `Order ID: ${orderId}\n` +
      `Type: ${typeLabel}\n` +
      `Country: ${cLabel}\n` +
      `Accounts: ${st.quantity}\n` +
      `Amount: ₹${st.price}\n\n` +
      `Admin is verifying your purchase. Once approved, you'll be connected with admin right here.`,
      mainMenu());

    bot.sendPhoto(ADMIN_ID, fileId, {
      caption:
        `🛒 New Account Purchase Request!\n\n` +
        `Order ID: ${orderId}\n` +
        `User: ${users[chatId]?.name || "Unknown"} (${chatId})\n` +
        `Username: @${users[chatId]?.username || "N/A"}\n` +
        `Type: ${typeLabel}\n` +
        `Country: ${cLabel}\n` +
        `Quantity: ${st.quantity}\n` +
        `Amount: ₹${st.price}\n` +
        `Time: ${new Date().toLocaleString("en-IN")}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `accord_approve_${orderId}` },
          { text: "❌ Reject", callback_data: `accord_reject_${orderId}` },
        ]]
      },
    }).catch(() => {
      bot.sendMessage(ADMIN_ID,
        `New Account Order!\nOrder: ${orderId}\nUser: ${users[chatId]?.name} (${chatId})\nType: ${typeLabel}\nCountry: ${cLabel}\nQty: ${st.quantity}\nAmount: ₹${st.price}\nScreenshot forward failed.`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `accord_approve_${orderId}` }, { text: "❌ Reject", callback_data: `accord_reject_${orderId}` }]] } }
      ).catch(() => { });
    });
    return;
  }

});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
process.on("unhandledRejection", r => console.error("Unhandled rejection:", r));
process.on("uncaughtException", e => console.error("Uncaught exception:", e.message));