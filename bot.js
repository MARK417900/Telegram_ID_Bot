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
const ADMIN_ID = 8521844327;

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
// Countries available for stock. Add more lines here (key must be letters/numbers only).
const COUNTRIES = {
  india: { label: "🇮🇳 India" },
  nepal: { label: "🇳🇵 Nepal" },
  // bangladesh: { label: "🇧🇩 Bangladesh" },
  // usa: { label: "🇺🇸 USA" },
};
const ACCOUNT_MAX_QTY = 10;
const ADD_STOCK_MAX_QTY = 500;
const PAYMENT_QR = "https://raw.githubusercontent.com/MARK417900/telegram-invite-bot/main/PaymentQR.jpg";
const UPI_ID = "7891624054@mbk";

// ─── DEPOSIT CONFIG ───────────────────────────────────────────────────────────
const MIN_DEPOSIT = 10;
const MAX_DEPOSIT = 10000;

// ─── Escape special Markdown characters in user-supplied text ─────────────────
function escMD(text) {
  if (!text) return "";
  return String(text).replace(/[*`\[]/g, "\\$&");
}

// ─── IN-MEMORY STORE ──────────────────────────────────────────────────────────
let users = {};
let pendingDeposits = {};
let pendingAccountOrders = {};
// stock[type][country] = [ "email:pass", ... ]
let stock = {};
for (const t of Object.keys(ACCOUNT_TYPES)) {
  stock[t] = {};
  for (const c of Object.keys(COUNTRIES)) stock[t][c] = [];
}
let adminReplyMap = {};       // { adminMessageId: userChatId } — swipe-reply support messages
let orderMsgMap = {};         // { adminMessageId: orderId }    — swipe-reply order chat messages
let botOnline = true;
let adminState = {};
let userState = {};

function genOrderId() {
  return "ACC" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

function genTxnId() {
  return "TXN" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

const stockCount = (type, country) => (stock[type] && stock[type][country] ? stock[type][country].length : 0);
const typeTotal = (type) => Object.values(stock[type] || {}).reduce((s, arr) => s + arr.length, 0);
const totalStock = () => Object.keys(ACCOUNT_TYPES).reduce((s, t) => s + typeTotal(t), 0);

function stockSummaryText() {
  let out = "";
  for (const [tk, t] of Object.entries(ACCOUNT_TYPES)) {
    out += `${t.label} — ₹${t.price} each (total ${typeTotal(tk)})\n`;
    for (const [ck, c] of Object.entries(COUNTRIES)) {
      out += `   ${c.label}: ${stockCount(tk, ck)}\n`;
    }
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

// Texts that are menu buttons — these must never be relayed into an order chat.
const MENU_TEXTS = new Set([
  "👤 Profile", "💰 Deposit", "Stock", "🛒 Buy Account", "🤝 Refer & Earn", "🆘 Support",
  "📢 Broadcast", "📊 Bot Status", "👤 MSG User", "🔴 Bot OFF", "🟢 Bot ON", "👥 All Users",
  "📦 Add Stock", "💬 Active Orders", "🔙 User Menu",
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
      .map(([k, t]) => `${t.label} — ₹${t.price} each (In stock: ${typeTotal(k)})`)
      .join("\n")
  );
}

// Generic country picker. prefix + countryKey = callback_data
function countryKeyboard(prefix, accType, cancelData, { requireStock = false } = {}) {
  const rows = [];
  let row = [];
  for (const [key, c] of Object.entries(COUNTRIES)) {
    const n = stockCount(accType, key);
    if (requireStock && n === 0) continue;
    row.push({ text: `${c.label} (${n})`, callback_data: `${prefix}${key}` });
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

function buyAccountQtyText(accType, country, qty) {
  const t = ACCOUNT_TYPES[accType];
  const c = COUNTRIES[country];
  return (
    `🛒 Buy ${t.label} Account (${c.label})\n\n` +
    `How many accounts would you like to buy?\n` +
    `In stock: ${stockCount(accType, country)}\n\n` +
    `Price: ₹${t.price} per account\n` +
    `Total: ₹${qty * t.price}`
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
function orderChatKeyboard(orderId) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Order Done", callback_data: `order_done_${orderId}` },
        { text: "❌ Cancel Order", callback_data: `order_cancel_${orderId}` },
      ]],
    },
  };
}

const typeLabelOf = (o) => ACCOUNT_TYPES[o.accType]?.label || o.accType;
const countryLabelOf = (o) => COUNTRIES[o.country]?.label || o.country;
const priceTextOf = (o) => (o.isFree ? "FREE 🎁" : `₹${o.price}`);

function activeOrderOfUser(chatId) {
  const list = Object.values(pendingAccountOrders).filter(o => o.chatActive && o.chatId === chatId);
  return list.length ? list[list.length - 1] : null;
}

function activeOrders() {
  return Object.values(pendingAccountOrders).filter(o => o.chatActive);
}

// Which order does an admin message belong to? Swipe-reply wins, else the only active order.
function resolveAdminOrder(msg) {
  const rid = msg.reply_to_message && orderMsgMap[msg.reply_to_message.message_id];
  if (rid && pendingAccountOrders[rid]?.chatActive) return pendingAccountOrders[rid];
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
  const kb = orderChatKeyboard(order.orderId);
  const remember = (s) => { if (s) orderMsgMap[s.message_id] = order.orderId; };
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    bot.sendPhoto(ADMIN_ID, fileId, { caption: orderHeader(order) + (msg.caption || ""), ...kb })
      .then(remember).catch(() => { });
  } else if (msg.text) {
    send(ADMIN_ID, orderHeader(order) + msg.text, kb).then(remember);
  }
}

function startOrderChat(order, delivered) {
  order.status = "approved";
  order.chatActive = true;
  order.deliveredItems = delivered;

  const typeLabel = typeLabelOf(order);
  let userText =
    `✅ Your order has been approved!\n\n` +
    `Order ID: ${order.orderId}\n` +
    `Type: ${typeLabel}\n` +
    `Country: ${countryLabelOf(order)}\n` +
    `Accounts: ${order.quantity}\n` +
    `Amount: ${priceTextOf(order)}\n\n`;
  if (delivered.length) {
    userText += `Your account details:\n` + delivered.map(d => tapCopy(d)).join("\n") + `\n\n`;
  } else {
    userText += `Admin will send your account details here shortly.\n\n`;
  }
  userText += `💬 You are now connected with admin for this order. Just type here and your messages go to admin directly.`;
  sendMD(order.chatId, userText, mainMenu());

  let adminText =
    `✅ Order ${order.orderId} approved — chat started\n` +
    `User: ${users[order.chatId]?.name || order.chatId} (${order.chatId})\n` +
    `${typeLabel} • ${countryLabelOf(order)} • x${order.quantity} • ${priceTextOf(order)}\n`;
  if (delivered.length) {
    adminText += `\n📦 ${delivered.length} account(s) auto-sent from stock.\n`;
  } else {
    adminText += `\n⚠️ Not enough ${countryLabelOf(order)} ${typeLabel} stock — send the account details to the user in this chat.\n`;
  }
  adminText += `\n↩️ Swipe-reply to any message of this order to talk to the user.\nWhen finished tap ✅ Order Done (or ❌ Cancel Order).`;
  send(ADMIN_ID, adminText, orderChatKeyboard(order.orderId))
    .then(s => { if (s) orderMsgMap[s.message_id] = order.orderId; });
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
    send(chatId, "👑 Welcome Admin!", adminMenu());
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
    if (msg.reply_to_message && orderMsgMap[msg.reply_to_message.message_id] && text) {
      const order = pendingAccountOrders[orderMsgMap[msg.reply_to_message.message_id]];
      if (order && order.chatActive) {
        send(order.chatId, `👨‍💼 Admin:\n\n${text}`);
        return;
      }
      send(chatId, "❌ That order chat is already closed.");
      return;
    }

    // ── SWIPE-REPLY RELAY (support messages) ────────────────────────────────
    if (msg.reply_to_message && adminReplyMap[msg.reply_to_message.message_id] && text) {
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
          send(chatId, `✅ Photo broadcast sent to ${n} users.`, adminMenu());
          return;
        }
        if (st.action === "msg_user_photo") {
          bot.sendPhoto(st.targetId, fileId, { caption: caption ? `${caption}` : "...." })
            .then(() => send(chatId, "✅ Photo sent.", adminMenu()))
            .catch(() => send(chatId, "❌ Failed to send photo.", adminMenu()));
          delete adminState[chatId];
          return;
        }
      }

      if (text === "❌ Cancel") {
        delete adminState[chatId];
        send(chatId, "❌ Cancelled.", adminMenu());
        return;
      }

      if (st.action === "broadcast") {
        let n = 0;
        Object.keys(users).forEach(uid => {
          if (+uid !== ADMIN_ID) { bot.sendMessage(uid, `${text}`).catch(() => { }); n++; }
        });
        delete adminState[chatId];
        send(chatId, `✅ Broadcast sent to ${n} users.`, adminMenu());
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
          .then(() => send(chatId, "✅ Message sent.", adminMenu()))
          .catch(() => send(chatId, "❌ Failed to send.", adminMenu()));
        delete adminState[chatId];
        return;
      }

      // ── ADD STOCK — STEP 3: QUANTITY ────────────────────────────────────
      if (st.action === "add_stock_qty") {
        if (!text || !/^\d+$/.test(text.trim())) {
          send(chatId, "❌ Please send a valid number (e.g. 5), or tap Cancel.", cancelKb());
          return;
        }
        const qty = parseInt(text.trim(), 10);
        if (qty < 1 || qty > ADD_STOCK_MAX_QTY) {
          send(chatId, `❌ Quantity must be between 1 and ${ADD_STOCK_MAX_QTY}.`, cancelKb());
          return;
        }
        adminState[chatId] = { action: "add_stock_items", type: st.type, country: st.country, qty };
        send(chatId,
          `📦 Adding ${qty} ${ACCOUNT_TYPES[st.type].label} (${COUNTRIES[st.country].label}) account${qty > 1 ? "s" : ""}\n\n` +
          `Now send exactly ${qty} account detail${qty > 1 ? "s" : ""}, one per line. Example:\n` +
          `user1@mail.com:pass123\n` +
          `user2@mail.com:pass456`,
          cancelKb());
        return;
      }

      // ── ADD STOCK — STEP 4: ACCOUNT DETAILS → PREVIEW + CONFIRM ─────────
      if (st.action === "add_stock_items") {
        if (!text) { send(chatId, "❌ Please send the account details as text.", cancelKb()); return; }
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length !== st.qty) {
          send(chatId,
            `❌ You said ${st.qty} but sent ${lines.length} line${lines.length === 1 ? "" : "s"}.\n` +
            `Send exactly ${st.qty} line${st.qty > 1 ? "s" : ""} (one account per line), or tap Cancel.`,
            cancelKb());
          return;
        }
        adminState[chatId] = { action: "add_stock_confirm", type: st.type, country: st.country, items: lines };
        const preview = lines.slice(0, 10).join("\n") + (lines.length > 10 ? `\n… and ${lines.length - 10} more` : "");
        send(chatId,
          `📦 Confirm Stock\n\n` +
          `Type: ${ACCOUNT_TYPES[st.type].label}\n` +
          `Country: ${COUNTRIES[st.country].label}\n` +
          `Quantity: ${lines.length}\n\n` +
          `${preview}\n\n` +
          `Add these to stock?`,
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
    if (text === "💬 Active Orders") {
      const list = activeOrders();
      if (!list.length) { send(chatId, "No active order chats right now.", adminMenu()); return; }
      list.forEach(o => {
        send(chatId,
          `💬 Order ${o.orderId}\n` +
          `User: ${users[o.chatId]?.name || o.chatId} (${o.chatId})\n` +
          `${typeLabelOf(o)} • ${countryLabelOf(o)} • x${o.quantity} • ${priceTextOf(o)}`,
          orderChatKeyboard(o.orderId)
        ).then(s => { if (s) orderMsgMap[s.message_id] = o.orderId; });
      });
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

    // ── PLAIN ADMIN TEXT → ORDER CHAT (only when no swipe-reply is needed) ──
    if (text && !MENU_TEXTS.has(text) && !st) {
      const active = activeOrders();
      if (active.length === 1) {
        send(active[0].chatId, `👨‍💼 Admin:\n\n${text}`);
        return;
      }
      if (active.length > 1) {
        send(chatId,
          `⚠️ ${active.length} order chats are active. Swipe-reply to a specific order message so I know who to send it to.\n` +
          `Tap 💬 Active Orders to see them all.`);
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
  // Step 1 → pick type → Step 2 → pick country
  if (data.startsWith("addstock_type_")) {
    if (!isAdmin(chatId)) return;
    const type = data.replace("addstock_type_", "");
    if (!ACCOUNT_TYPES[type]) return;
    adminState[chatId] = { action: "add_stock_country", type };
    bot.editMessageText(
      `📦 Add ${ACCOUNT_TYPES[type].label} Stock\n\nWhich country are these accounts from?`,
      {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: countryKeyboard("addstock_country_", type, "addstock_cancel"),
      }
    ).catch(() => { });
    return;
  }

  // Step 2 → country chosen → ask quantity
  if (data.startsWith("addstock_country_")) {
    if (!isAdmin(chatId)) return;
    const st = adminState[chatId];
    if (!st || st.action !== "add_stock_country") return;
    const country = data.replace("addstock_country_", "");
    if (!COUNTRIES[country]) return;
    adminState[chatId] = { action: "add_stock_qty", type: st.type, country };
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `📦 Add ${ACCOUNT_TYPES[st.type].label} • ${COUNTRIES[country].label} Stock\n\n` +
      `How many accounts do you want to add? Send a number (1 – ${ADD_STOCK_MAX_QTY}).\n\n` +
      `Current stock: ${stockCount(st.type, country)}`,
      cancelKb());
    return;
  }

  // Step 5 → confirm and add
  if (data === "addstock_confirm") {
    if (!isAdmin(chatId)) return;
    const st = adminState[chatId];
    if (!st || st.action !== "add_stock_confirm") return;
    stock[st.type][st.country].push(...st.items);
    const added = st.items.length;
    const label = `${ACCOUNT_TYPES[st.type].label} ${COUNTRIES[st.country].label}`;
    const nowCount = stockCount(st.type, st.country);
    delete adminState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `✅ Added ${added} ${label} account${added > 1 ? "s" : ""} to stock.\n` +
      `📦 ${label} stock now: ${nowCount}\n` +
      `📦 Total stock: ${totalStock()}`,
      adminMenu());
    return;
  }

  if (data === "addstock_cancel") {
    if (!isAdmin(chatId)) return;
    delete adminState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId, "❌ Add stock cancelled.", adminMenu());
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
  // ── TYPE SELECTED → COUNTRY ─────────────────────────────────────────────────
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
    if (!COUNTRIES[country]) return;
    if (stockCount(st.accType, country) < 1) {
      send(chatId, `❌ ${ACCOUNT_TYPES[st.accType].label} (${COUNTRIES[country].label}) is out of stock. Choose another country.`);
      return;
    }
    userState[chatId] = { action: "buy_account_qty", accType: st.accType, country, quantity: 1 };
    bot.editMessageText(buyAccountQtyText(st.accType, country, 1), {
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
    const maxQty = Math.min(ACCOUNT_MAX_QTY, stockCount(st.accType, st.country));
    let qty = st.quantity;
    qty = data === "buyacc_plus" ? Math.min(maxQty, qty + 1) : Math.max(1, qty - 1);
    if (qty === st.quantity) return;
    st.quantity = qty;
    bot.editMessageText(buyAccountQtyText(st.accType, st.country, qty), {
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
    const price = qty * t.price;
    bot.deleteMessage(chatId, msgId).catch(() => { });
    userState[chatId] = { action: "buy_account_qr", accType, country, quantity: qty, price };
    bot.sendPhoto(chatId, PAYMENT_QR, {
      caption:
        `🛒 Buy ${qty} ${t.label} (${COUNTRIES[country].label}) Account${qty > 1 ? "s" : ""}\n\n` +
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

    // Approve → auto-deliver from matching country stock if possible, then START ORDER CHAT
    const pool = (stock[order.accType] && stock[order.accType][order.country]) || [];
    const delivered = pool.length >= order.quantity ? pool.splice(0, order.quantity) : [];
    startOrderChat(order, delivered);
    return;
  }

  // ── ORDER CHAT: ✅ DONE / ❌ CANCEL (admin only) ────────────────────────────
  if (data.startsWith("order_done_") || data.startsWith("order_cancel_")) {
    if (!isAdmin(chatId)) return;
    const isDone = data.startsWith("order_done_");
    const orderId = data.replace(isDone ? "order_done_" : "order_cancel_", "");
    const order = pendingAccountOrders[orderId];
    if (!order || !order.chatActive) {
      send(chatId, "❌ This order chat is already closed or not found.");
      return;
    }
    order.chatActive = false;

    if (isDone) {
      order.status = "completed";
      send(chatId, `✅ Order ${orderId} marked as DONE. Chat closed.`);
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
      } else if (REFUND_ON_CANCEL && users[order.chatId] && order.price > 0) {
        users[order.chatId].balance = (users[order.chatId].balance || 0) + order.price;
        extra = `\n\n₹${order.price} has been added to your bot balance.`;
      }
      send(chatId, `❌ Order ${orderId} CANCELLED. Chat closed.`);
      send(order.chatId,
        `❌ Your order has been cancelled by admin.\n\n` +
        `Order ID: ${orderId}${extra}\n\n` +
        `If you have questions, use 🆘 Support.`,
        mainMenu());
    }
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
        reply_markup: countryKeyboard(`refclaim_country_${accType}_`, accType, "refclaim_cancel", { requireStock: true }),
      }
    ).catch(() => { });
    return;
  }

  if (data.startsWith("refclaim_country_")) {
    const [, , accType, country] = data.split("_");
    const u = users[chatId];
    if (!ACCOUNT_TYPES[accType] || !COUNTRIES[country]) return;
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
      status: "pending", timestamp: new Date(),
    };
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `🎁 Free account request sent!\n\n` +
      `Order ID: ${orderId}\n` +
      `Type: ${ACCOUNT_TYPES[accType].label}\n` +
      `Country: ${COUNTRIES[country].label}\n\n` +
      `Admin will approve it shortly and chat with you here.`,
      mainMenu());
    send(ADMIN_ID,
      `🎁 FREE Account Claim (referral reward)\n\n` +
      `Order ID: ${orderId}\n` +
      `User: ${u.name || "Unknown"} (${chatId})\n` +
      `Username: @${u.username || "N/A"}\n` +
      `Type: ${ACCOUNT_TYPES[accType].label}\n` +
      `Country: ${COUNTRIES[country].label}\n` +
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

    // ── SWIPE-REPLY / SINGLE ACTIVE ORDER: photo to user in order chat ────
    const isReplyToSupport = msg.reply_to_message && adminReplyMap[msg.reply_to_message.message_id];
    if (!isReplyToSupport && !adminState[chatId]) {
      const order = resolveAdminOrder(msg);
      if (order) {
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
    const countryLabel = COUNTRIES[st.country]?.label || st.country;
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
      `Country: ${countryLabel}\n` +
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
        `Country: ${countryLabel}\n` +
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
        `New Account Order!\nOrder: ${orderId}\nUser: ${users[chatId]?.name} (${chatId})\nType: ${typeLabel}\nCountry: ${countryLabel}\nQty: ${st.quantity}\nAmount: ₹${st.price}\nScreenshot forward failed.`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `accord_approve_${orderId}` }, { text: "❌ Reject", callback_data: `accord_reject_${orderId}` }]] } }
      ).catch(() => { });
    });
    return;
  }

});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
process.on("unhandledRejection", r => console.error("Unhandled rejection:", r));
process.on("uncaughtException", e => console.error("Uncaught exception:", e.message));