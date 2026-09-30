// src/modules/shifts/shifts.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const validateBranch = require("../../middlewares/validateBranch");
const withNotify = require("../../core/withNotify");

const {
  openShift, closeShift, ackDrawer,
  getAll, getSummary, getMine, getCurrent, getReport,
} = require("./shifts.controller");

const idField = z.coerce.number().int().positive();

/// المبلغ في الدرج — بيبدأ من صفر (درج فاضي حالة عادية)
const money = z.coerce.number().min(0).max(100000000);

/// ⚠ `z.coerce.boolean()` بيعمل Boolean(v) — يعني النص "false"
///   بيتحوّل لـ true. الفلاتر لو بعت force: "false" (نص) كان
///   بيقفل درج الموظف المفتوح ويفتح جديد من غير ما حد يطلب.
///   لازم تحويل صريح زي `boolParam` في branches.
const boolParam = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

const openSchema = z.object({
  body: z.object({
    branch_id: idField,
    tenant_id: idField.optional(), // للـ super_admin

    // الدرج اللي هيشتغل عليه. لو الفرع فيه درج واحد ممكن يتساب،
    // وأكتر من درج بيرجّع 400 DRAWER_REQUIRED ومعاه القايمة.
    drawer_id: idField.optional(),

    // استلم الدرج زي ما السيستم قال
    confirmed: boolParam.optional(),
    // أو لقى رقم تاني — بيتسجّل فرق باسمه
    counted: money.optional(),
    // الرقم اللي الشاشة عرضته — لو اتغيّر بيرجّع 409 بالجديد
    expected_seen: money.optional(),

    // true = اقفل الشيفت المفتوح وافتح جديد
    force: boolParam.optional().default(false),
  }),
});

const closeSchema = z.object({
  body: z
    .object({
      shift_id: idField.optional(), // المديرين بس
      branch_id: idField.optional(),
      tenant_id: idField.optional(),

      // اللي في الدرج فعلاً — مطلوب لأي وردية عليها درج.
      // من غيره بيرجّع 400 COUNT_REQUIRED ومعاه المتوقع.
      counted: money.optional(),
      expected_seen: money.optional(),
    })
    .optional()
    .default({}),
});

const ackSchema = z.object({
  body: z
    .object({
      confirmed: boolParam.optional(),
      counted: money.optional(),
      expected_seen: money.optional(),
      tenant_id: idField.optional(),
    })
    .optional()
    .default({}),
});

const listSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    drawer_id: idField.optional(),
    tenant_id: idField.optional(),
    page: z.coerce.number().int().positive().max(10000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    // ← كل الفروع المسموحة بدل الفرع الحالي
    all_branches: z.enum(["true", "false"]).optional(),
    // ← المفتوحة بس / المقفولة بس
    status: z.enum(["open", "closed"]).optional(),
  }),
});

// ids = "19,18,17" — أرقام بس مفصولة بفواصل
const summarySchema = z.object({
  query: z.object({
    ids: z
      .string()
      .max(10000)
      .regex(/^\d+(,\d+)*$/, "ids must be comma-separated numbers.")
      .optional(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM.").optional(),
    year: z.string().regex(/^\d{4}$/, "year must be YYYY.").optional(),
    all_branches: z.enum(["true", "false"]).optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const reportSchema = z.object({
  params: z.object({ id: idField }),
});

router.use(auth);

// فتح شيفت — لازم فرع متأكد منه (المختار)
// ⚠ validateBranch بيتأكد إن الفرع موجود وشغّال وتابع للسنتر —
//   مش إن اليوزر ليه صلاحية عليه. الفحص ده في الكنترولر.
router.post(
  "/open",
  validate(openSchema),
  validateBranch({ required: true }),
  requireRole(...STAFF),
  withNotify(openShift, ["shifts_updated", "drawers_updated"])
);

// قفل الشيفت المفتوح بتاع اليوزر (أو شيفت محدد للمديرين)
router.post(
  "/close",
  validate(closeSchema),
  requireRole(...STAFF),
  withNotify(closeShift, [
    "shifts_updated",
    "payments_updated",
    "drawers_updated",
  ])
);

// تأكيد رصيد الدرج بعد ما حد تاني قفل عليه
router.post(
  "/ack",
  validate(ackSchema),
  requireRole(...STAFF),
  withNotify(ackDrawer, ["shifts_updated", "drawers_updated"])
);

router.get("/current", requireRole(...STAFF), getCurrent);

router.get("/mine", requireRole(...STAFF), getMine);

// ملخص مجموعة جلسات (كارت الشهر/السنة) — طلب واحد
// الريسبشن جلساته بس، والأدمن فروعه بس (مفلتر في الكنترولر)
router.get(
  "/summary",
  validate(summarySchema),
  requireRole(...STAFF),
  getSummary
);

// كل الشيفتات — الريسبشن بيشوف بتاعته بس، والأدمن فروعه بس (مفلتر في الكنترولر)
router.get("/", validate(listSchema), requireRole(...STAFF), getAll);

router.get(
  "/:id/report",
  validate(reportSchema),
  requireRole(...STAFF),
  getReport
);

module.exports = router;