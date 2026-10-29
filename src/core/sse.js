// src/core/sse.js
// كل اتصال مربوط بصاحبه: { userId, tenantId }
// عشان التحديثات تروح للسنتر بتاعها بس، والخروج الإجباري يوصل للموظف الصح
const clients = new Map(); // res → { userId, tenantId }

function addClient(res, meta = {}) {
  clients.set(res, {
    userId: meta.userId ?? null,
    tenantId: meta.tenantId ?? null,
  });
}

function removeClient(res) {
  clients.delete(res);
}

const format = (event, data) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const safeWrite = (res, payload) => {
  try {
    res.write(payload);
  } catch (_) {
    clients.delete(res); // الاتصال مات
  }
};

/**
 * بيبعت حدث:
 *  - tenantId موجود → برامج السنتر ده بس (+ الـ super_admin)
 *  - مش موجود      → للكل (السلوك القديم — لحد ما withNotify يبعت السنتر)
 */
function notify(event, data = {}, tenantId) {
  const payload = format(event, data);
  for (const [res, meta] of clients) {
    if (
      tenantId != null &&
      meta.tenantId != null &&
      meta.tenantId !== tenantId
    ) {
      continue;
    }
    safeWrite(res, payload);
  }
}

/** حدث ليوزر معيّن بس (زي الخروج الإجباري) */
function notifyUser(userId, event, data = {}) {
  const payload = format(event, data);
  for (const [res, meta] of clients) {
    if (meta.userId === userId) safeWrite(res, payload);
  }
}

/** بيقفل كل اتصالات اليوزر (بعد ما جلسته تخلص) */
function disconnectUser(userId) {
  for (const [res, meta] of clients) {
    if (meta.userId !== userId) continue;
    clients.delete(res);
    try {
      res.end();
    } catch (_) {}
  }
}

/**
 * بيقفل كل اتصالات الـSSE المفتوحة. بتتنده وقت إغلاق السيرفر بس.
 *
 * ⚠ من غيرها الإغلاق بياخد ١٠ ثواني كل مرة.
 *
 *   `server.close()` معناها «بطّل تستقبل اتصالات جديدة، ونادي
 *   عليا لما الموجود يخلص». واتصالات الـSSE دي **مابتخلصش
 *   بطبيعتها** — دي وظيفتها تفضل مفتوحة عشان التحديثات الحيّة.
 *   فالنداء ماكانش بييجي أبدًا، والعملية كانت تفضل عايشة لحد ما
 *   مؤقّت الطوارئ يقتلها بعد ١٠ ثواني — ونودمون يطلّع
 *   EADDRINUSE لأن البورت لسه متاخد.
 *
 *   بنقفلهم بإيدنا الأول، فالـ`close` بتلاقي الطريق فاضي.
 */
function closeAll() {
  const open = clients.size;
  for (const res of clients.keys()) {
    try {
      res.end();
    } catch (_) {
      // الاتصال مات قبلنا — مش مشكلة، إحنا بنقفل أصلاً
    }
  }
  clients.clear();
  return open;
}

module.exports = {
  addClient,
  removeClient,
  notify,
  notifyUser,
  disconnectUser,
  closeAll,
};
