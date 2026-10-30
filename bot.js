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
const GROUP_ID = -1003345786666;
const GROUP_INVITE_LINK = "https://t.me/+pNRg_oJqSaFlZWE1";
const REFER_REWARD = 10;

// ─── BUY ACCOUNT CONFIG ────────────────────────────────────────────────────
// Each account type has its own label and price (₹ per account). Change freely.
const ACCOUNT_TYPES = {
  whatsapp: { label: "📱 WhatsApp", price: 40 },
  telegram: { label: "✈️ Telegram", price: 40 },
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
// Pool of account strings available to sell, per type, e.g. "email:pass" / "+91xxxx:otp"
let stock = { whatsapp: [], telegram: [] };
let adminReplyMap = {};       // { adminMessageId: userChatId } — lets admin swipe-reply to relay a message back to a user
let botOnline = true;
let adminState = {};
let userState = {};

function genOrderId() {
  return "ACC" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

function genTxnId() {
  return "TXN" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

const totalStock = () => Object.values(stock).reduce((s, arr) => s + arr.length, 0);

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
      referRewardPaid: false,
      referCount: 0,
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

// ─── MENUS ────────────────────────────────────────────────────────────────────
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "👤 Profile" }, { text: "Stock" }],
        [{ text: "🛒 Buy Account" }, { text: "💰 Deposit" }],
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
        [{ text: "📦 Add Stock" }],
        [{ text: "🔙 User Menu" }],
      ],
      resize_keyboard: true,
    },
  };
}

const cancelKb = (label = "❌ Cancel") => ({
  reply_markup: {
    keyboard: [[{ text: label }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
});

// ─── BUY ACCOUNT: TYPE + QUANTITY KEYBOARDS ─────────────────────────────────
function accountTypeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: ACCOUNT_TYPES.whatsapp.label, callback_data: "buyacc_type_whatsapp" },
          { text: ACCOUNT_TYPES.telegram.label, callback_data: "buyacc_type_telegram" },
        ],
        [{ text: "❌ Cancel", callback_data: "buyacc_cancel" }],
      ],
    },
  };
}

function accountTypeText() {
  return (
    `🛒 Buy Account\n\n` +
    `Which type of account do you want?\n\n` +
    `${ACCOUNT_TYPES.whatsapp.label} — ₹${ACCOUNT_TYPES.whatsapp.price} each (In stock: ${stock.whatsapp.length})\n` +
    `${ACCOUNT_TYPES.telegram.label} — ₹${ACCOUNT_TYPES.telegram.price} each (In stock: ${stock.telegram.length})`
  );
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

function buyAccountQtyText(accType, qty) {
  const t = ACCOUNT_TYPES[accType];
  return (
    `🛒 Buy ${t.label} Account\n\n` +
    `How many accounts would you like to buy?\n\n` +
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

// ─── GROUP MEMBERSHIP ─────────────────────────────────────────────────────────
async function isGroupMember(userId) {
  try {
    const member = await bot.getChatMember(GROUP_ID, userId);
    return ["member", "administrator", "creator", "restricted"].includes(member.status);
  } catch {
    return false;
  }
}

async function requireGroupMembership(chatId, onSuccess) {
  const isMember = await isGroupMember(chatId);
  if (isMember) { onSuccess(); return; }
  send(chatId,
    `You must join our group.\nJoin the group and then try again!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Join Group", url: GROUP_INVITE_LINK }],
          [{ text: "▶️ I've Joined — Continue", callback_data: "check_membership" }],
        ],
      },
    });
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

  const isMember = await isGroupMember(chatId);
  if (!isMember) {
    send(chatId,
      `⚠️ To use the bot you must join our official group first.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Join Our Group", url: GROUP_INVITE_LINK }],
            [{ text: "▶️ I've Joined", callback_data: "check_membership" }],
          ]
        },
      });
    return;
  }
  send(chatId,
    `Welcome in Mark's Community, ${msg.from.first_name}`,
    mainMenu());
});

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("message", msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;

  if (!text && !photo) return;
  if (text && text.startsWith("/")) return;

  registerUser(msg);

  // ══════════════════════ ADMIN ══════════════════════════════════════════════
  if (isAdmin(chatId)) {

    // ── SWIPE-REPLY RELAY: admin replies to a forwarded user message ────────
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

      // ── ADD STOCK — STEP 2: QUANTITY ────────────────────────────────────
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
        adminState[chatId] = { action: "add_stock_items", type: st.type, qty };
        send(chatId,
          `📦 Adding ${qty} ${ACCOUNT_TYPES[st.type].label} account${qty > 1 ? "s" : ""}\n\n` +
          `Now send exactly ${qty} account detail${qty > 1 ? "s" : ""}, one per line. Example:\n` +
          `user1@mail.com:pass123\n` +
          `user2@mail.com:pass456`,
          cancelKb());
        return;
      }

      // ── ADD STOCK — STEP 3: ACCOUNT DETAILS → PREVIEW + CONFIRM ─────────
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
        adminState[chatId] = { action: "add_stock_confirm", type: st.type, items: lines };
        const preview = lines.slice(0, 10).join("\n") + (lines.length > 10 ? `\n… and ${lines.length - 10} more` : "");
        send(chatId,
          `📦 Confirm Stock\n\n` +
          `Type: ${ACCOUNT_TYPES[st.type].label}\n` +
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

      // ── MANUAL ACCOUNT DELIVERY (used when stock is insufficient on approve) ─
      if (st.action === "deliver_account_manual") {
        const order = pendingAccountOrders[st.orderId];
        if (!order) { send(chatId, "❌ Order not found."); delete adminState[chatId]; return; }
        order.status = "approved";
        order.deliveredItems = [text];
        delete adminState[chatId];
        send(chatId, `✅ Order ${st.orderId} approved & delivered manually.`, adminMenu());
        send(order.chatId,
          `✅ Your account purchase has been approved!\n\n` +
          `Order ID: ${st.orderId}\n` +
          `Type: ${ACCOUNT_TYPES[order.accType]?.label || order.accType}\n` +
          `Accounts: ${order.quantity}\n` +
          `Amount Paid: ₹${order.price}\n\n` +
          `Your account details:\n${text}`,
          mainMenu());
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
        `📦 Add Stock\n\n` +
        `Which type of accounts do you want to add?\n\n` +
        `${ACCOUNT_TYPES.whatsapp.label}: ${stock.whatsapp.length} in stock\n` +
        `${ACCOUNT_TYPES.telegram.label}: ${stock.telegram.length} in stock`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: ACCOUNT_TYPES.whatsapp.label, callback_data: "addstock_type_whatsapp" },
                { text: ACCOUNT_TYPES.telegram.label, callback_data: "addstock_type_telegram" },
              ],
              [{ text: "❌ Cancel", callback_data: "addstock_cancel" }],
            ],
          },
        });
      return;
    }
    if (text === "📊 Bot Status") {
      const totalUsers = Object.keys(users).filter(id => +id !== ADMIN_ID).length;
      const allOrders = Object.values(pendingAccountOrders);
      const pendingOrders = allOrders.filter(o => o.status === "pending").length;
      const approvedOrders = allOrders.filter(o => o.status === "approved");
      const totalAccountsSold = approvedOrders.reduce((s, o) => s + o.quantity, 0);
      const totalRevenue = approvedOrders.reduce((s, o) => s + o.price, 0);
      const pendingDepositsCount = Object.values(pendingDeposits).filter(d => d.status === "pending").length;

      const since = Date.now() - 24 * 60 * 60 * 1000;
      const orders24h = approvedOrders.filter(o => o.timestamp && new Date(o.timestamp).getTime() >= since);
      const revenue24h = orders24h.reduce((s, o) => s + o.price, 0);
      const accounts24h = orders24h.reduce((s, o) => s + o.quantity, 0);

      send(chatId,
        `📊 Bot Status\n\n` +
        `Status: ${botOnline ? "🟢 Online" : "🔴 Offline"}\n` +
        `Total Users: ${totalUsers}\n` +
        `📦 Stock Available: ${totalStock()}\n` +
        `   ${ACCOUNT_TYPES.whatsapp.label}: ${stock.whatsapp.length}\n` +
        `   ${ACCOUNT_TYPES.telegram.label}: ${stock.telegram.length}\n` +
        `Pending Orders: ${pendingOrders}\n` +
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
  }

  // ══════════════════════ USER ═══════════════════════════════════════════════
  if (!botOnline) { send(chatId, "🔴 Bot is offline for maintenance."); return; }

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
      `Refer Count: ${u.referCount || 0}\n` +
      (pd ? `\n\nPending Deposit: ₹${pd.amount} (TXN: ${tapCopy(pd.txnId)})` : ""),
      mainMenu());
    return;
  }

  if (text === "Stock") {
    send(chatId,
      `📦 Stock Status\n\n` +
      `${ACCOUNT_TYPES.whatsapp.label}: ${stock.whatsapp.length} available — ₹${ACCOUNT_TYPES.whatsapp.price} each\n` +
      `${ACCOUNT_TYPES.telegram.label}: ${stock.telegram.length} available — ₹${ACCOUNT_TYPES.telegram.price} each\n\n` +
      (totalStock() > 0
        ? `Tap "🛒 Buy Account" to purchase now!`
        : `Currently out of stock. Please check back later.`),
      mainMenu());
    return;
  }

  // ── DEPOSIT: START ────────────────────────────────────────────────────────
  if (text === "💰 Deposit") {
    requireGroupMembership(chatId, () => {
      const existing = Object.values(pendingDeposits).find(d => d.chatId === chatId && d.status === "pending");
      if (existing) {
        send(chatId, `⏳ You already have a pending deposit: ${existing.txnId} | ₹${existing.amount}\nPlease wait for admin to verify it.`, mainMenu());
        return;
      }
      userState[chatId] = { action: "deposit_amount" };
      send(chatId,
        `💰 Deposit\n\nEnter the amount you want to deposit (₹${MIN_DEPOSIT} – ₹${MAX_DEPOSIT}):`,
        cancelKb());
    });
    return;
  }

  // ── BUY ACCOUNT: START (CHOOSE TYPE) ──────────────────────────────────────
  if (text === "🛒 Buy Account") {
    requireGroupMembership(chatId, () => {
      userState[chatId] = { action: "buy_account_type" };
      send(chatId, accountTypeText(), accountTypeKeyboard());
    });
    return;
  }

  if (text === "🤝 Refer & Earn") {
    sendMD(chatId,
      `🤝 Your Referral Link:\n` +
      `${`https://t.me/TgStoreBot?start=${chatId}`}\n\n` +
      `Earn ₹${REFER_REWARD} for each valid friend who buy atleast one account !`
    );
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
});

// ─────────────────────────────────────────────────────────────────────────────
//  CALLBACK QUERY HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("callback_query", query => {
  const data = query.data;
  const msgId = query.message.message_id;
  const isGroupCallback = query.message.chat.type !== "private";
  const chatId = isGroupCallback ? query.from.id : query.message.chat.id;

  bot.answerCallbackQuery(query.id).catch(() => { });

  if (data === "noop") {
    return;
  }

  if (data === "check_membership") {
    isGroupMember(chatId).then(isMember => {
      if (isMember) {
        bot.deleteMessage(chatId, msgId).catch(() => { });
        send(chatId, `🎲 Welcome in Marks Community !!`, mainMenu());
      } else {
        send(chatId,
          `❌ You haven't joined yet!\n\nPlease join the group first, then tap "I've Joined" again.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Join Our Group", url: GROUP_INVITE_LINK }],
                [{ text: "▶️ I've Joined — Continue", callback_data: "check_membership" }],
              ]
            },
          });
      }
    });
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
  // Step 1 → pick type
  if (data.startsWith("addstock_type_")) {
    if (!isAdmin(chatId)) return;
    const type = data.replace("addstock_type_", "");
    if (!ACCOUNT_TYPES[type]) return;
    adminState[chatId] = { action: "add_stock_qty", type };
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId,
      `📦 Add ${ACCOUNT_TYPES[type].label} Stock\n\n` +
      `How many accounts do you want to add? Send a number (1 – ${ADD_STOCK_MAX_QTY}).\n\n` +
      `Current ${ACCOUNT_TYPES[type].label} stock: ${stock[type].length}`,
      cancelKb());
    return;
  }

  // Step 4 → confirm and add
  if (data === "addstock_confirm") {
    if (!isAdmin(chatId)) return;
    const st = adminState[chatId];
    if (!st || st.action !== "add_stock_confirm") return;
    stock[st.type].push(...st.items);
    const added = st.items.length;
    const label = ACCOUNT_TYPES[st.type].label;
    const nowCount = stock[st.type].length;
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
  // ── BUY ACCOUNT: TYPE SELECTED (WhatsApp / Telegram) → QUANTITY ─────────────
  if (data.startsWith("buyacc_type_")) {
    const accType = data.replace("buyacc_type_", "");
    if (!ACCOUNT_TYPES[accType]) return;
    userState[chatId] = { action: "buy_account_qty", accType, quantity: 1 };
    bot.editMessageText(buyAccountQtyText(accType, 1), {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: buyAccountQtyKeyboard(1).reply_markup,
    }).catch(() => { });
    return;
  }

  // ── BUY ACCOUNT: QUANTITY STEPPER ──────────────────────────────────────────
  if (data === "buyacc_minus" || data === "buyacc_plus") {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_qty") return;
    let qty = st.quantity;
    qty = data === "buyacc_plus" ? Math.min(ACCOUNT_MAX_QTY, qty + 1) : Math.max(1, qty - 1);
    if (qty === st.quantity) return;
    st.quantity = qty;
    bot.editMessageText(buyAccountQtyText(st.accType, qty), {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: buyAccountQtyKeyboard(qty).reply_markup,
    }).catch(() => { });
    return;
  }

  // ── BUY ACCOUNT: CANCEL (TYPE OR QUANTITY STAGE) ────────────────────────────
  if (data === "buyacc_cancel") {
    delete userState[chatId];
    bot.editMessageText("❌ Purchase cancelled.", { chat_id: chatId, message_id: msgId }).catch(() => { });
    send(chatId, "You can start a new purchase anytime from the menu.", mainMenu());
    return;
  }

  // ── BUY ACCOUNT: CONFIRM QUANTITY → SHOW QR ─────────────────────────────────
  if (data === "buyacc_confirm") {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_qty") return;
    const { accType, quantity: qty } = st;
    const t = ACCOUNT_TYPES[accType];
    const price = qty * t.price;
    bot.deleteMessage(chatId, msgId).catch(() => { });
    userState[chatId] = { action: "buy_account_qr", accType, quantity: qty, price };
    bot.sendPhoto(chatId, PAYMENT_QR, {
      caption:
        `🛒 Buy ${qty} ${t.label} Account${qty > 1 ? "s" : ""}\n\n` +
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

  // ── BUY ACCOUNT: CANCEL AT QR STAGE ─────────────────────────────────────────
  if (data === "buyacc_cancel_qr") {
    delete userState[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => { });
    send(chatId, "❌ Purchase cancelled.", mainMenu());
    return;
  }

  // ── BUY ACCOUNT: "I HAVE PAID" → ASK FOR SCREENSHOT ─────────────────────────
  if (data === "buyacc_paid") {
    const st = userState[chatId];
    if (!st || st.action !== "buy_account_qr") return;
    bot.deleteMessage(chatId, msgId).catch(() => { });
    userState[chatId] = { action: "buy_account_screenshot", accType: st.accType, quantity: st.quantity, price: st.price };
    send(chatId,
      `📷 Please upload the payment screenshot.\n\n⚠ Screenshot must contain the UTR number.`,
      cancelKb("❌ Cancel Purchase"));
    return;
  }

  // ── BUY ACCOUNT: ADMIN APPROVE / REJECT ─────────────────────────────────────
  if (data.startsWith("accord_approve_") || data.startsWith("accord_reject_")) {
    if (!isAdmin(chatId)) return;
    const isApprove = data.startsWith("accord_approve_");
    const orderId = data.replace(isApprove ? "accord_approve_" : "accord_reject_", "");
    const order = pendingAccountOrders[orderId];
    if (!order || order.status !== "pending") {
      send(chatId, "❌ Order not found or already processed.");
      return;
    }
    const typeLabel = ACCOUNT_TYPES[order.accType]?.label || order.accType;

    if (!isApprove) {
      order.status = "rejected";
      send(chatId, `❌ Order ${orderId} rejected.`);
      send(order.chatId,
        `❌ Your account purchase request was rejected.\n\n` +
        `Order ID: ${orderId}\n\n` +
        `Please contact support if you believe this is a mistake.`,
        mainMenu());
      return;
    }

    // Approve — try to auto-deliver from the matching stock pool first
    const pool = stock[order.accType] || [];
    if (pool.length >= order.quantity) {
      const delivered = pool.splice(0, order.quantity);
      order.status = "approved";
      order.deliveredItems = delivered;
      send(chatId,
        `✅ Order ${orderId} approved & auto-delivered from stock.\n` +
        `User: ${users[order.chatId]?.name || order.chatId}\n` +
        `Type: ${typeLabel}\n` +
        `Qty: ${order.quantity}\n` +
        `Remaining ${typeLabel} Stock: ${pool.length}`);
      sendMD(order.chatId,
        `✅ Your account purchase has been approved!\n\n` +
        `Order ID: ${orderId}\n` +
        `Type: ${typeLabel}\n` +
        `Accounts: ${order.quantity}\n` +
        `Amount Paid: ₹${order.price}\n\n` +
        `Your account details:\n` +
        delivered.map(d => tapCopy(d)).join("\n"),
        mainMenu());
    } else {
      // Not enough stock — ask admin to type the delivery message manually
      adminState[chatId] = { action: "deliver_account_manual", orderId };
      send(chatId,
        `⚠️ Not enough ${typeLabel} stock! (Have ${pool.length}, need ${order.quantity})\n\n` +
        `Type the account details to send to the user manually, or tap 📦 Add Stock first and then approve again.`,
        cancelKb());
    }
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PHOTO HANDLER
// ─────────────────────────────────────────────────────────────────────────────
bot.on("photo", msg => {
  const chatId = msg.chat.id;

  if (isAdmin(chatId)) {
    // ── SWIPE-REPLY RELAY WITH A PHOTO ────────────────────────────────────
    if (msg.reply_to_message && adminReplyMap[msg.reply_to_message.message_id]) {
      const targetUserId = adminReplyMap[msg.reply_to_message.message_id];
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      bot.sendPhoto(targetUserId, fileId, {
        caption: msg.caption ? `💬 Message from Admin:\n\n${msg.caption}` : "💬 Message from Admin",
      }).then(() => send(chatId, `✅ Photo reply sent to ${users[targetUserId]?.name || targetUserId}.`))
        .catch(() => send(chatId, "❌ Failed to send photo reply."));
    }
    return;
  }

  const st = userState[chatId];
  if (!st) return;

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
    pendingAccountOrders[orderId] = {
      orderId,
      chatId,
      accType: st.accType,
      quantity: st.quantity,
      price: st.price,
      screenshotFileId: fileId,
      status: "pending",
      timestamp: new Date(),
    };
    delete userState[chatId];

    send(chatId,
      `📸 Screenshot Received!\n\n` +
      `Order ID: ${orderId}\n` +
      `Type: ${typeLabel}\n` +
      `Accounts: ${st.quantity}\n` +
      `Amount: ₹${st.price}\n\n` +
      `Admin is verifying your purchase. You will be notified.`,
      mainMenu());

    bot.sendPhoto(ADMIN_ID, fileId, {
      caption:
        `🛒 New Account Purchase Request!\n\n` +
        `Order ID: ${orderId}\n` +
        `User: ${users[chatId]?.name || "Unknown"} (${chatId})\n` +
        `Username: @${users[chatId]?.username || "N/A"}\n` +
        `Type: ${typeLabel}\n` +
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
        `New Account Order!\nOrder: ${orderId}\nUser: ${users[chatId]?.name} (${chatId})\nType: ${typeLabel}\nQty: ${st.quantity}\nAmount: ₹${st.price}\nScreenshot forward failed.`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `accord_approve_${orderId}` }, { text: "❌ Reject", callback_data: `accord_reject_${orderId}` }]] } }
      ).catch(() => { });
    });
    return;
  }

});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
process.on("unhandledRejection", r => console.error("Unhandled rejection:", r));
process.on("uncaughtException", e => console.error("Uncaught exception:", e.message));