// src/modules/portal/student_portal.routes.js
//
// ⚠ الراوتس دي **عامة** — مفيش `auth` ولا `X-Client-Key`.
//   (app.js بيستثني /api/portal من فحص العميل المسموح)
//   يعني أي حد على الإنترنت يقدر ينادي عليها، فكل واحدة ليها
//   limiter خاص بيها.
const express = require("express");
const router = express.Router();
const { z } = require("zod");
const rateLimit = require("express-rate-limit");

const validate = require("../../middlewares/validate");

const {
  getRegisterForm,
  submitRegistration,
  openPortalSession,
  portalAuth,
  getMe,
  updateMe,
  regenerateMyQr,
} = require("./student_portal.controller");

// ── Limiters ──────────────────────────────────────────────
// ⚠ كان فيه `keyGenerator` بيقرا `req.ip` بإيده — والمكتبة بترفضه
//   (ERR_ERL_KEY_GEN_IPV6) لأن عنوان IPv6 واحد بيقدر يولّد ملايين
//   العناوين، فالعدّاد بالعنوان الكامل مالوش أي قيمة.
//
//   السلوك الافتراضي أصلاً بيعدّ بالـ IP وبيجمّع شبكات IPv6 مع
//   بعضها صح، و`trust proxy` متظبّطة في app.js فـ `req.ip` بيطلع
//   عنوان الطالب الحقيقي مش عنوان الـ proxy. يعني الافتراضي هو
//   اللي كنت عايزه من الأول.

/// فتح الصفحة — سخي، الطالب ممكن يعمل refresh
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "طلبات كتير. استنى شوية." },
});

/// إرسال طلب تسجيل — ضيّق
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "TOO_MANY",
    message: "اتبعت طلبات كتير. استنى شوية أو كلّم موظف الاستقبال.",
  },
});

/// الدخول بالكود — أضيق حاجة. ده المدخل الوحيد اللي ينفع
/// يتخمّن فيه، فلازم يبقى بطيء بما يكفي إنه مايستاهلش.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "TOO_MANY",
    message: "محاولات كتير. استنى ١٠ دقايق.",
  },
});

/// تغيير الكود — ٣ مرات في الساعة **لكل طالب**، مش لكل IP.
///
/// ⚠ العدّاد بالطالب مش بالعنوان عن قصد: طلاب السنتر كلهم على
///   واي فاي واحد = IP واحد، فالعدّ بالـ IP كان معناه إن أول
///   تلات طلاب يغيّروا كودهم يقفلوا الزرار على الباقيين.
///   عشان كده الـ limiter ده بييجي **بعد** `portalAuth` في
///   الراوت تحت — محتاج `req.portal` يكون اتملى.
const regenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => "s:" + req.portal.studentId,
  message: {
    success: false,
    code: "TOO_MANY",
    message: "غيّرت الكود كذا مرة. استنى ساعة.",
  },
});

// ── Schemas ───────────────────────────────────────────────
const phone = z.string().trim().min(8).max(20);
const courseIds = z.array(z.coerce.number().int().positive()).max(30).optional();
const idField = z.coerce.number().int().positive();

const tokenParam = z.object({
  params: z.object({ token: z.string().min(16).max(128) }),
});

const submitSchema = z.object({
  params: z.object({ token: z.string().min(16).max(128) }),
  body: z.object({
    name: z.string().trim().min(2).max(150),
    phone,
    parent_phone: phone,
    alt_phone: z.string().trim().max(20).optional(),
    notes: z.string().trim().max(300).optional(),
    semester_id: idField.optional(),
    course_ids: courseIds,
  }),
});

const sessionSchema = z.object({
  body: z.object({
    portal_code: z.string().trim().min(4).max(32),
    phone,
  }),
});

const updateSchema = z.object({
  body: z.object({
    parent_phone: phone.optional(),
    alt_phone: z.string().trim().max(20).nullable().optional(),
    semester_id: idField.optional(),
    course_ids: courseIds,
  }),
});

// ── التسجيل ───────────────────────────────────────────────
router.get(
  "/register/:token",
  readLimiter,
  validate(tokenParam),
  getRegisterForm,
);

router.post(
  "/register/:token",
  submitLimiter,
  validate(submitSchema),
  submitRegistration,
);

// ── التعديل ───────────────────────────────────────────────
router.post(
  "/session",
  loginLimiter,
  validate(sessionSchema),
  openPortalSession,
);

router.get("/me", readLimiter, portalAuth, getMe);

router.put("/me", submitLimiter, portalAuth, validate(updateSchema), updateMe);

router.post("/me/qr", portalAuth, regenLimiter, regenerateMyQr);

module.exports = router;