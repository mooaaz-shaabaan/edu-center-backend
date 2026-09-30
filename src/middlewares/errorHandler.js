// src/middlewares/errorHandler.js
// Global error catcher — بيمسك أي خطأ غير متوقع ويرجع response منظم

const isProd = process.env.NODE_ENV === "production";

module.exports = (err, req, res, next) => {
  // حدّد الـ status بدري عشان نعرف نوع الخطأ
  const status = err.status || err.statusCode || 500;
  const isPrismaError = err.code?.startsWith("P");

  // logging ذكي:
  // - الأخطاء الحقيقية (5xx) أو غير المتوقعة → log كامل بالـ stack
  // - الرفض المتوقع (4xx زي "not found"، "validation") → سطر هادي بس
  if (status >= 500 || isPrismaError) {
    console.error("❌ Error:", {
      message: err.message,
      code: err.code,
      name: err.name,
      path: req.originalUrl,
      method: req.method,
      user: req.user?.id || "anonymous",
      ...(isProd ? {} : { stack: err.stack }),
    });
  } else if (!isProd) {
    // رفض متوقع — في التطوير بس، سطر واحد بسيط (مش أحمر مخيف)
    console.log(`↩️  ${status} ${req.method} ${req.originalUrl} — ${err.message}`);
  }

  // ── Prisma errors ──────────────────────────────────────
  if (err.code === "P2002") {
    return res.status(409).json({
      success: false,
      message: "Duplicate entry. This record already exists.",
      // متبعتش اسم العمود في الـ production (تسريب schema)
      ...(isProd ? {} : { field: err.meta?.target }),
    });
  }

  if (err.code === "P2025") {
    return res.status(404).json({ success: false, message: "Record not found." });
  }

  // أخطاء Prisma تانية (foreign key، إلخ) — رسالة عامة
  if (err.code?.startsWith("P")) {
    return res.status(400).json({
      success: false,
      message: "Database operation failed.",
      ...(isProd ? {} : { code: err.code, meta: err.meta }),
    });
  }

  // ── JWT errors ─────────────────────────────────────────
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({ success: false, message: "Invalid token." });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      message: "Token expired. Please login again.",
      code: "TOKEN_EXPIRED",
    });
  }

  // ── Validation errors ──────────────────────────────────
  if (err.name === "ValidationError" || err.name === "ZodError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed.",
      ...(isProd ? {} : { details: err.issues || err.message }),
    });
  }

  // ── Body parser / JSON errors ──────────────────────────
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON payload." });
  }

  // ── Default ────────────────────────────────────────────

  res.status(status).json({
    success: false,
    // في الـ production: رسالة عامة للـ 500 (متسربش err.message)
    // الأخطاء الأقل من 500 (زي 400/403) ممكن نوريها لأنها مقصودة
    message:
      status >= 500 && isProd
        ? "Internal Server Error"
        : err.message || "Internal Server Error",
  });
};