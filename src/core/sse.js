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

module.exports = {
  addClient,
  removeClient,
  notify,
  notifyUser,
  disconnectUser,
};
