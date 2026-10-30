const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const hpp = require("hpp");
const compression = require("compression");
const path = require("path");

const errorHandler = require("./middlewares/errorHandler");
const auth = require("./middlewares/auth");
const requireAppClient = require("./middlewares/appClient");
const { addClient, removeClient } = require("./core/sse");
const coursesRoutes = require("./modules/courses/courses.routes");

const app = express();
const isProd = process.env.NODE_ENV === "production";

// ── Trust Proxy ───────────────────────────────────────────
// ضروري لو ورا nginx/reverse proxy عشان req.ip و secure cookies يشتغلوا صح
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── Security Headers ──────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: isProd ? undefined : false,
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

// ── CORS ──────────────────────────────────────────────────
// قائمة origins مسموح بيها من الـ env (مفصولة بفواصل)
// مثال: ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
//
// ⚠ لو ALLOWED_ORIGINS مش موجودة، بنرجع لـ FRONTEND_URL —
//   من غير كده أي متصفح كان هيترفض (تطبيق الديسكتوب شغال لأنه
//   مابيبعتش Origin أصلاً، فالمشكلة كانت هتظهر أول ما تجرّب Flutter web)
const stripSlash = (o) => o.trim().replace(/\/+$/, "");

const allowedOrigins = [
  ...(process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || "").split(","),
  process.env.PORTAL_BASE_URL || "",
]
  .map(stripSlash)
  .filter(Boolean);

const corsBase = {
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true, // ضروري عشان الكوكيز
  maxAge: 86400,
};

/**
 * الطلب جاي من صفحة السيرفر ده نفسه؟
 *
 * ⚠ ده اللي كان ناقص. بوابة الطلاب (public/student) بيقدّمها
 *   **نفس** السيرفر، وبتنادي الـ API بمسار نسبي — يعني نفس الأصل.
 *   المتصفح بيبعت `Origin` مع أي POST حتى لو نفس الأصل، والفحص
 *   كان بيقارنه بقايمة ثابتة فيها IP واحد. فالطالب اللي بيفتح
 *   اللينك بـ `localhost` أو بأي IP تاني للسيرفر كان بيترفض:
 *
 *     Not allowed by CORS — POST /api/portal/register/...
 *
 *   نفس الأصل أصلاً مش محتاج CORS — المتصفح بيسمح بيه لوحده.
 *   فرفضه كان بق مش حماية.
 */
const isSameOrigin = (req, origin) => {
  if (!req.headers.host) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (_) {
    return false;
  }
};

app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;

    // مفيش Origin (تطبيق الديسكتوب، curl، السيرفر لنفسه) → عدّي
    if (!origin) return callback(null, { ...corsBase, origin: true });

    if (isSameOrigin(req, origin) ||
        allowedOrigins.includes(stripSlash(origin))) {
      return callback(null, { ...corsBase, origin: true });
    }

    // ⚠ بـ status: من غيره الـ errorHandler بيعتبرها خطأ سيرفر
    //   ويرجّع 500 ويطبع stack كامل في اللوج لكل محاولة — ضوضاء
    //   بتخفي الأخطاء الحقيقية. ده رفض متوقع، مش عطل.
    const err = new Error("Not allowed by CORS");
    err.status = 403;
    return callback(err);
  }),
);

// ── Body Parsers ──────────────────────────────────────────
app.use(express.json({ limit: "1mb" })); // قللناها من 10mb (10mb خطر للـ JSON)
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// ── Extra Hardening ───────────────────────────────────────
app.use(hpp()); // ضد HTTP Parameter Pollution

// ← عدّل compression عشان يتخطى الـ SSE
app.use(
  compression({
    filter: (req, res) => {
      // متضغطش الـ SSE stream — الضغط بيمنع البيانات من الوصول فوراً
      if (req.path === "/api/stream") return false;
      return compression.filter(req, res);
    },
  }),
);

// ── Global Rate Limiter ───────────────────────────────────
// حماية عامة لكل الـ API (الـ login عنده limiter أصرم في الـ routes بتاعته)
//
// ⚠ كان 100 طلب / 15 دقيقة مفتاحها الـ IP.
//   الـ keyGenerator بيقرا req.user، بس الـ limiter بيشتغل قبل الـ auth
//   فـ req.user دايماً undefined → المفتاح الـ IP على طول.
//   والسنتر كله ورا راوتر واحد = IP واحد، يعني ٤ أجهزة بيتقاسموا
//   ٦ طلبات في الدقيقة. أول يوم شغل حقيقي كان هيبقى 429 على طول.
//
//   الحل: المفتاح بقى بصمة التوكن (كل موظف بسلّته) مع الرجوع للـ IP
//   لو مفيش توكن، والحد اترفع لمستوى واقعي.
const tokenKey = (req) => {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    // بصمة بس — التوكن نفسه مايتخزنش في ذاكرة الـ limiter
    return (
      "t:" +
      crypto
        .createHash("sha256")
        .update(header.slice(7))
        .digest("hex")
        .slice(0, 24)
    );
  }
  return ipKeyGenerator(req);
};

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // ٤ طلبات/ثانية للمستخدم الواحد — كفاية لأي استخدام طبيعي
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenKey,
  // الـ SSE اتصال واحد مفتوح ساعات — مالوش لازمة في العدّاد
  skip: (req) => req.originalUrl.startsWith("/api/stream"),
  message: { success: false, message: "Too many requests. Please slow down." },
});

// ── Session (نبضة / خروج / خروج إجباري) ──────────────────
// قبل الـ limiter: النبضة كل دقيقة ما تاكلش من الحد
app.use("/api/session", require("./modules/session/session.routes"));

app.use("/api", globalLimiter);

// ── العميل المسموح ────────────────────────────────────────
// الطلبات لازم تيجي من برنامج السنتر (هيدر X-Client-Key).
//
// مستثنى:
//   /api/health  → المراقبة والـ uptime checks
//   /api/portal  → صفحة الطالب العامة، مالهاش برنامج
//
// بيتطبّق على كل حاجة تانية مش على /auth/login بس — وإلا اللي معاه
// توكن يقدر يستخدم كل الـ API من بوستمان عادي.
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/portal")) return next();
  return requireAppClient(req, res, next);
});

// ── Health Check ──────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: process.env.APP_NAME || "Markazi",
    timestamp: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

// ── SSE Stream ────────────────────────────────────────────
app.get("/api/stream", auth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // ابعت حاجة فوراً عشان العميل يتأكد إن الـ stream شغّال
  res.write(": connected\n\n");

  // ⚠ الـ console.log اللي كان هنا بيتنفّذ لكل عميل كل ٣٠ ثانية —
  //   ١٠ أجهزة = ٢٨٨٠٠ سطر لوج في اليوم من غير أي فايدة
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  // ← كل اتصال مربوط بصاحبه: التحديثات للسنتر بتاعه بس + الخروج الإجباري
  addClient(res, { userId: req.user.id, tenantId: req.user.tenant_id });

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

// ── Routes ────────────────────────────────────────────────

// ⚠ لازم يبقوا الأول خالص.
//   `branches.routes` و `semesters.routes` متركّبين على "/api"
//   نفسها (مش "/api/branches")، وجواهم `router.use(auth)` اللي
//   بتشتغل على كل طلب تحت /api. لو أي حاجة فيهم اتنفّذت قبل
//   دول، صفحات الطالب العامة بترجع 401.
app.use("/api/portal", require("./modules/portal/student_portal.routes"));
app.use("/api/auth", require("./modules/auth/auth.routes"));
app.use("/api/students", require("./modules/students/students.routes"));
app.use("/api/shifts", require("./modules/shifts/shifts.routes"));
app.use("/api/attendance", require("./modules/attendance/attendance.routes"));
app.use("/api/schedules", require("./modules/schedules/schedules.routes"));
app.use("/api", require("./modules/branches/branches.routes"));
app.use("/api/payments", require("./modules/payments/payments.routes"));
app.use("/api/reports", require("./modules/reports/reports.routes"));
app.use("/api/search", require("./modules/search/search.routes"));
app.use("/api", require("./modules/semesters/semesters.routes"));
app.use("/api/users", require("./modules/users/users.routes"));
app.use("/api/exams", require("./modules/exams/exams.routes"));
app.use("/api/tenants", require("./modules/tenants/tenants.routes"));
// إعلان تحديث البرنامج — مالك النظام بينشر، والكل بيقرا
app.use("/api/app-release", require("./modules/app_release/app_release.routes"));
app.use("/api/courses", coursesRoutes);
app.use("/api/dashboard", require("./modules/dashboard/dashboard.routes"));
app.use(
  "/api/registrations",
  require("./modules/registrations/registrations.routes"),
);
app.use("/api/drawers", require("./modules/drawers/drawers.routes"));

// ── روابط الطالب العامة ───────────────────────────────────
//
// ⚠ الروابط دي مش جوّه النظام — دي اللي بتتحط في الـ QR وبتتبعت
//   في واتساب، فاللي بيقراها ولي أمر مش موظف:
//
//     /register/TOKEN  →  صفحة طلب التسجيل
//     /student         →  صفحة بيانات الطالب
//
//   كانت `/r/TOKEN` و `/student/me`. `/r` كان أقصر بـ٧ حروف بس
//   محدش يعرف معناه، والرابط اللي مش مفهوم محدش بيدوس عليه.
//   والتوكن بقى ٢٢ حرف بدل ٣٢ (شوف `newToken`)، فالـ QR طلع
//   بنفس عدد المربعات بالظبط (٣٧) — الاسم الواضح مجاني.
//
//   كل الروابط القديمة لسه شغالة: `/r/` بيوجّه على الجديد تحت،
//   و `?t=` و `.html` من الـ static.
//
//   ⚠ الفولدر مش مثبّت في الكود: الصفحات ممكن تتحط في أي فولدر
//     جوه public، ولو المسار هنا مختلف عن الفولدر الحقيقي الـ QR
//     بيوصل لصفحة 404 ومحدش هيعرف ليه.
const PORTAL_DIR = (process.env.PORTAL_PATH || "student").replace(
  /^\/+|\/+$/g,
  "",
);

const portalPage = (file) => (req, res, next) =>
  res.sendFile(
    path.join(__dirname, "../public", PORTAL_DIR, file),
    (err) => err && next(err),
  );

app.get("/register/:token", portalPage("register.html"));
app.get("/my-data", portalPage("me.html"));

// ⚠ أي QR اتطبع أو رسالة اتبعتت قبل كده فيها `/r/` — لازم تفضل
//   شغالة. ٣٠١ عشان الرابط الجديد هو اللي يبان في المتصفح.
//
//   الشرط على شكل التوكن مش تزيين: من غيره الراوت بياخد أي حاجة
//   في المسار ويحطها في ترويسة Location.
app.get("/r/:token", (req, res, next) => {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(req.params.token)) return next();
  res.redirect(301, `/register/${req.params.token}`);
});

// ── Static Files ──────────────────────────────────────────
// بعد الـ API routes (عشان مايعترضش عليها) — مع cache headers
app.use(
  express.static(path.join(__dirname, "../public"), {
    // `/student/me` بتشتغل زي `/student/me.html` — الامتداد في
    // الرابط حاجة من الملفات مش حاجة الطالب المفروض يشوفها.
    // ⚠ الروابط القديمة بـ `.html` بتفضل شغالة زي ما هي.
    extensions: ["html"],
    maxAge: isProd ? "1d" : 0,
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }),
);

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ── Error Handler (آخر حاجة دايمًا) ───────────────────────
app.use(errorHandler);

module.exports = app;
