// src/core/session.js
// ── جلسة واحدة لكل حساب + خروج تلقائي بعد 5 دقايق من غير اتصال ──
//
// البرنامج وهو مفتوح بيبعت "نبضة" كل دقيقة (POST /api/session/heartbeat)
// والسيرفر بيسجّل آخر نبضة في users.last_seen_at:
//   - آخر نبضة من أقل من دقيقتين → الموظف "متصل"
//   - آخر نبضة من أقل من 5 دقايق  → الجلسة لسه مفتوحة (ممكن النت فصل ويرجع)
//   - أقدم من كده / فاضي         → الجلسة خلصت (خروج تلقائي)
const prisma = require("../config/db");
const { disconnectUser } = require("./sse");

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const CONNECTED_WINDOW_MS = 2 * 60 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const ageMs = (lastSeenAt, now) => now - new Date(lastSeenAt).getTime();

const isConnected = (lastSeenAt, now = Date.now()) =>
  !!lastSeenAt && ageMs(lastSeenAt, now) < CONNECTED_WINDOW_MS;

const hasOpenSession = (lastSeenAt, now = Date.now()) =>
  !!lastSeenAt && ageMs(lastSeenAt, now) < SESSION_TIMEOUT_MS;

/**
 * بيفتح جلسة جديدة — بس لو مفيش جلسة مفتوحة للحساب.
 * atomic: لو جهازين دخلوا في نفس اللحظة، واحد بس اللي بينجح.
 * وبيزوّد token_version عشان أي توكن قديم متعلّق (من crash مثلاً) يبطل.
 * @returns token_version الجديد، أو null لو الحساب مفتوح على جهاز تاني
 */
async function startSession(userId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - SESSION_TIMEOUT_MS);

  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ last_seen_at: null }, { last_seen_at: { lt: cutoff } }],
    },
    data: { last_seen_at: now, token_version: { increment: 1 } },
  });
  if (count === 0) return null;

  // أي refresh token من جلسة قديمة اتقفلت فجأة يتلغي
  await prisma.refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: now },
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { token_version: true },
  });
  return user.token_version;
}

/**
 * نبضة: بتحدّث آخر ظهور — بس لو نفس التوكن لسه صالح والجلسة ما اتقفلتش.
 * (لو خروج إجباري حصل في نفس اللحظة، النبضة ما ترجّعش الجلسة تاني)
 */
async function touchSession(userId, tokenVersion) {
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      token_version: tokenVersion,
      last_seen_at: { not: null },
    },
    data: { last_seen_at: new Date() },
  });
  return count > 0;
}

/**
 * بينهي جلسة اليوزر: أي توكن قديم يبطل + الـ refresh tokens تتلغي.
 * db = prisma أو tx (جوه transaction)
 * ⚠️ بعد الـ commit نادي closeUserStreams(userId)
 */
async function endSession(userId, db = prisma) {
  const now = new Date();
  await db.user.update({
    where: { id: userId },
    data: { last_seen_at: null, token_version: { increment: 1 } },
  });
  await db.refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: now },
  });
}

const closeUserStreams = (userId) => disconnectUser(userId);

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  CONNECTED_WINDOW_MS,
  SESSION_TIMEOUT_MS,
  isConnected,
  hasOpenSession,
  startSession,
  touchSession,
  endSession,
  closeUserStreams,
};
