// src/middlewares/appClient.js
const crypto = require("crypto");

/**
 * بيتأكد إن الطلب جاي من برنامج السنتر مش من بوستمان أو سكربت.
 *
 * ⚠ ده رادع مش حماية:
 *   المفتاح بيتشحن جوه الملف التنفيذي، فاللي يقدر يقراه أو يراقب
 *   الشبكة يقدر ينسخ الهيدر ويبعته من أي مكان.
 *   بيمنع الاستخدام العَرَضي والموظف اللي بيجرّب في الـ API —
 *   مش مهاجم جاد. الحماية الحقيقية هي التوكن والصلاحيات.
 *
 * مفيش APP_CLIENT_KEY في الـ env → الميدلوير متعطّل (مفيد في التطوير).
 */
const APP_CLIENT_KEY = process.env.APP_CLIENT_KEY || "";

/// مقارنة بزمن ثابت — المقارنة العادية بتسرّب طول البادئة الصح
const keyMatches = (given) => {
  if (!given || given.length !== APP_CLIENT_KEY.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(given, "utf8"),
    Buffer.from(APP_CLIENT_KEY, "utf8"),
  );
};

const requireAppClient = (req, res, next) => {
  if (!APP_CLIENT_KEY) return next(); // مش مفعّل

  if (keyMatches(req.get("X-Client-Key"))) return next();

  // مفيد لما تشوف محاولات في اللوج
  console.warn(
    `⛔ محاولة من عميل غير معروف — ${req.method} ${req.originalUrl} · ip=${req.ip} · ua=${req.get("user-agent") || "-"}`,
  );

  return res.status(403).json({
    success: false,
    code: "CLIENT_NOT_ALLOWED",
    message: "محاولة تسجيل فاشلة — برجاء تسجيل الدخول من البرنامج.",
  });
};

module.exports = requireAppClient;
