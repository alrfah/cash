const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();

const ADMIN_EMAIL = "smr57720@gmail.com";
const CURRENCIES = new Set(["usd", "syp", "try"]);
const ACCOUNT_RE = /^SY\d{24}$/;

function fail(code, message) {
  throw new functions.https.HttpsError(code, message);
}

exports.transferFunds = functions.https.onCall(async (data, context) => {
  if (!context.auth) fail("unauthenticated", "يجب تسجيل الدخول أولًا");

  const to = String(data && data.to || "").trim().toUpperCase();
  const cur = String(data && data.cur || "").trim().toLowerCase();
  const amount = Number(data && data.amount);
  if (!ACCOUNT_RE.test(to)) fail("invalid-argument", "رقم حساب المستلم غير صالح");
  if (!CURRENCIES.has(cur)) fail("invalid-argument", "العملة غير مدعومة");
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
    fail("invalid-argument", "قيمة الحوالة غير صالحة");
  }

  const uid = context.auth.uid;
  const senderIndex = await db.ref(`uidIndex/${uid}`).once("value");
  const senderId = senderIndex.val() && senderIndex.val().accountId;
  if (!senderId || !ACCOUNT_RE.test(senderId)) fail("permission-denied", "حساب المرسل غير موجود");
  if (senderId === to) fail("failed-precondition", "لا يمكن التحويل للحساب نفسه");

  const senderRef = db.ref(`accounts/${senderId}`);
  const recipientRef = db.ref(`accounts/${to}`);
  const [senderSnap, recipientSnap] = await Promise.all([senderRef.once("value"), recipientRef.once("value")]);
  if (!senderSnap.exists()) fail("not-found", "حساب المرسل غير موجود");
  if (!recipientSnap.exists()) fail("not-found", "الحساب المستلم غير موجود");
  const sender = senderSnap.val() || {};
  const recipient = recipientSnap.val() || {};
  if (sender.uid !== uid) fail("permission-denied", "لا تملك هذا الحساب");
  if (sender.balanceSuspended) fail("failed-precondition", "الرصيد معلّق من الإدارة");
  if (Number(sender[cur] || 0) < amount) fail("failed-precondition", "الرصيد غير كافٍ");

  // قفل قصير يمنع إرسال حوالتين متزامنتين من الحساب نفسه.
  const lockRef = db.ref(`transferLocks/${senderId}`);
  const lockResult = await lockRef.transaction(old => old ? undefined : { uid, ts: Date.now() });
  if (!lockResult.committed) fail("aborted", "توجد حوالة قيد التنفيذ؛ حاول مرة أخرى");

  let senderDebited = false;
  let recipientCredited = false;
  try {
    const debit = await senderRef.transaction(current => {
      if (!current || current.uid !== uid || Number(current[cur] || 0) < amount) return;
      return { ...current, [cur]: Number(current[cur] || 0) - amount };
    });
    if (!debit.committed) fail("failed-precondition", "الرصيد غير كافٍ أو تغيّر؛ حاول مرة أخرى");
    senderDebited = true;

    const credit = await recipientRef.transaction(current => {
      if (!current) return;
      return { ...current, [cur]: Number(current[cur] || 0) + amount };
    });
    if (!credit.committed) fail("aborted", "تعذر إضافة الحوالة للحساب المستلم");
    recipientCredited = true;

    const ts = Date.now();
    const txRef = db.ref("tx").push();
    const noticeRef = db.ref(`userNotifications/${to}`).push();
    const senderName = sender.fullname || sender.username || senderId;
    const recipientName = recipient.fullname || recipient.username || to;
    const transfer = {
      from: senderId,
      to,
      amount,
      cur,
      type: "transfer",
      ts,
      fromName: senderName,
      toName: recipientName,
      txId: txRef.key
    };
    const amountText = `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${cur === "usd" ? "دولار" : cur === "syp" ? "ليرة سورية" : "ليرة تركية"}`;
    const updates = {};
    updates[`tx/${txRef.key}`] = transfer;
    updates[`userNotifications/${to}/${noticeRef.key}`] = {
      type: "transfer",
      title: "وصلتك حوالة جديدة",
      text: `استلمت حوالة من ${senderName} بقيمة ${amountText}`,
      amount,
      cur,
      from: senderId,
      fromName: senderName,
      txId: txRef.key,
      ts,
      read: false
    };
    await db.ref().update(updates);
    return { transfer };
  } catch (err) {
    if (recipientCredited) {
      await recipientRef.transaction(current => {
        if (!current || Number(current[cur] || 0) < amount) return;
        return { ...current, [cur]: Number(current[cur] || 0) - amount };
      }).catch(() => {});
    }
    if (senderDebited) {
      // تعويض الخصم فقط إذا بقي الحساب كما هو بعد الخصم.
      await senderRef.transaction(current => {
        if (!current || current.uid !== uid) return;
        return { ...current, [cur]: Number(current[cur] || 0) + amount };
      }).catch(() => {});
    }
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("transferFunds", err);
    fail("internal", "تعذر تنفيذ الحوالة؛ حاول مرة أخرى");
  } finally {
    await lockRef.remove().catch(() => {});
  }
});

exports.sendUserPush = functions.https.onCall(async (data, context) => {
  if (!context.auth || String(context.auth.token && context.auth.token.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    fail("permission-denied", "غير مصرح بإرسال إشعارات الهاتف");
  }
  const requested = Array.isArray(data && data.accountIds) ? data.accountIds.map(String) : [];
  let accountIds = requested;
  if (requested.includes("all")) {
    const accounts = await db.ref("accounts").once("value");
    accountIds = Object.keys(accounts.val() || {});
  }
  const tokenSet = new Set();
  for (const id of accountIds.slice(0, 5000)) {
    const snap = await db.ref(`deviceTokens/${id}`).once("value");
    const values = snap.val() || {};
    Object.values(values).forEach(item => { if (item && item.token) tokenSet.add(String(item.token)); });
  }
  const tokens = [...tokenSet].slice(0, 500);
  if (!tokens.length) return { sent: 0, failed: 0 };
  const title = String(data && data.title || "الرفاه كاش").slice(0, 90);
  const body = String(data && data.body || "لديك إشعار جديد").slice(0, 500);
  const link = String(data && data.link || "https://alrfah-cash.web.app/");
  const result = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { title, body, link }
  });
  return { sent: result.successCount, failed: result.failureCount };
});
