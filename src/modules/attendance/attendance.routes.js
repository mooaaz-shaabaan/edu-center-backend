// src/modules/attendance/attendance.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireBranchAccess } = require("../../middlewares/rbac");
const validateBranch = require("../../middlewares/validateBranch");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getAll,
  listSessions,
  recordByQR,
  recordManual,
  syncOffline,
  getSummary,
} = require("./attendance.controller");

const idField = z.coerce.number().int().positive();

/// الحصة رقم كام في اليوم — الموظف بيختارها لما المادة يبقى ليها
/// أكتر من ميعاد. لو مبعوتش السيرفر بيختار الأقرب لوقت التسجيل.
const sessionNo = z.coerce.number().int().min(1).max(20).optional();

const listSchema = z.object({
  query: z.object({
    student_id: idField.optional(),
    date: z.string().datetime().optional().or(z.string().date().optional()),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    page: z.coerce.number().int().positive().max(10000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

/// مواعيد المادة النهاردة في الفرع الحالي
const sessionsSchema = z.object({
  query: z.object({
    course_id: idField,
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    // للاختبار أو للتسجيل بأثر رجعي
    date: z.string().datetime().optional().or(z.string().date().optional()),
  }),
});

const summarySchema = z.object({
  query: z.object({
    student_id: idField.optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    days: z.coerce.number().int().positive().max(365).optional(),
  }),
});

const paymentMode = z.enum(["wallet", "split", "cash"]).optional();

/// الصندوق اللي الكاش هيدخله.
///
/// مطلوب بس في حالة واحدة: اللي بيسجّل **مالوش وردية** (أونر/أدمن)
/// والفرع فيه **أكتر من درج شغّال**. غير كده السيرفر بيحدده لوحده —
/// من الوردية، أو من الفرع لو فيه درج واحد.
///
/// والحضور المدفوع من المحفظة مافيهوش كاش أصلاً، فمابيتطلبش درج.
const drawerField = idField.optional();

const qrSchema = z.object({
  body: z.object({
    qr_content: z.string().min(1).max(255),
    shift_id: idField.optional(),
    drawer_id: drawerField,
    branch_id: idField,
    course_id: idField,
    session_no: sessionNo,
    payment_mode: paymentMode,
    tenant_id: idField.optional(),
  }),
});

const manualSchema = z.object({
  body: z.object({
    student_id: idField,
    shift_id: idField.optional(), // ← لازم optional
    drawer_id: drawerField,
    branch_id: idField,
    course_id: idField,
    session_no: sessionNo,
    status: z.enum(["present", "absent", "late"]).optional(),
    notes: z.string().max(500).optional(),
    payment_mode: paymentMode,
    tenant_id: idField.optional(),
  }),
});

const syncSchema = z.object({
  body: z.object({
    branch_id: idField,
    tenant_id: idField.optional(),
    records: z
      .array(
        z.object({
          student_id: idField,
          date: z.string(),
          shift_id: idField.optional(),
          drawer_id: drawerField,
          course_id: idField.optional(),
          session_no: sessionNo,
          method: z.enum(["qr", "manual"]).optional(),
          status: z.enum(["present", "absent", "late"]).optional(),
          notes: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
});

router.use(auth);

// ⚠ الحارس بقى صلاحية على الفرع مش رتبة.
//
//   قبل كده كان `requireRole(...STAFF)` — أي موظف استقبال في
//   السنتر. و`validateBranch` بيتأكد إن الفرع حقيقي وشغّال
//   وتابع للسنتر، **مش إن اليوزر له وصول عليه**. يعني موظف
//   فرع المعادي كان يقدر يبعت `branch_id` بتاع النزهة ويسجّل
//   حضور ويقبض فلوس هناك.
//
//   `requireBranchAccess("attendance")` بيتأكد إن عنده الفيتشر
//   على الفرع ده تحديدًا، وبيسيب `req.allowedBranchIds` عشان
//   القراءة من غير فرع تتقيّد بفروعه هو.

router.get(
  "/",
  validate(listSchema),
  validateBranch({ required: false }),
  requireBranchAccess("attendance"),
  getAll,
);

/// ⚠ لازم يبقى قبل أي راوت فيه باراميتر زي "/:id"
router.get(
  "/sessions",
  validate(sessionsSchema),
  validateBranch({ required: true }), // المواعيد بتختلف من فرع لفرع
  requireBranchAccess("attendance"),
  listSessions,
);

router.get(
  "/summary",
  validate(summarySchema),
  validateBranch({ required: false }),
  requireBranchAccess("attendance"),
  getSummary,
);

router.post(
  "/qr",
  validate(qrSchema),
  validateBranch({ required: true }),
  requireBranchAccess("attendance"),
  withNotify(recordByQR, [
    "attendance_updated",
    "payments_updated",
    "drawers_updated",
  ]),
);

router.post(
  "/manual",
  validate(manualSchema),
  validateBranch({ required: true }),
  requireBranchAccess("attendance"),
  withNotify(recordManual, [
    "attendance_updated",
    "payments_updated",
    "drawers_updated",
  ]),
);

router.post(
  "/sync",
  validate(syncSchema),
  validateBranch({ required: true }),
  requireBranchAccess("attendance"),
  withNotify(syncOffline, [
    "attendance_updated",
    "payments_updated",
    "drawers_updated",
  ]),
);

module.exports = router;
