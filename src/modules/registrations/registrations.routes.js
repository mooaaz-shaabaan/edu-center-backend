// src/modules/registrations/registrations.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const {
  requireRole,
  STAFF,
  MANAGERS,
  requireBranchAccess,
} = require("../../middlewares/rbac");
const validateBranch = require("../../middlewares/validateBranch");
const validate = require("../../middlewares/validate");

const {
  list,
  options,
  update,
  approve,
  reject,
  bulk,
  getLink,
  rotateLink,
  setLinkActive,
} = require("./registrations.controller");

const idField = z.coerce.number().int().positive();
const idParam = z.object({ params: z.object({ id: idField }) });
const phone = z.string().trim().min(8).max(20);

const listSchema = z.object({
  query: z.object({
    status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
    /// بحث بالاسم أو أي رقم من التلاتة
    q: z.string().trim().max(100).optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    page: z.coerce.number().int().positive().max(10000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

/// تعديل الطلب قبل القبول.
///
/// ⚠ رقم الطالب مسموح يتغيّر هنا (بعكس تعديل الطالب لنفسه): ده
///   بالظبط اللي الموظف محتاجه لما الطالب يكتب رقمه غلط. الكنترولر
///   بيفحص إنه مش متسجّل لطالب تاني ولا لطلب تاني مستني.
const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(2).max(150).optional(),
    phone: phone.optional(),
    parent_phone: phone.optional(),
    alt_phone: z.string().trim().max(20).nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    semester_id: idField.nullable().optional(),
    course_ids: z.array(idField).max(30).optional(),
  }),
});

const rejectSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({ reason: z.string().trim().max(300).optional() }),
});

/// قبول / رفض جماعي.
///
/// ⚠ الـ ids إجبارية ومحدودة بـ ١٠٠: مفيش «اقبل كل اللي في الفلتر»
///   من غير قايمة صريحة. الفلتر بيتغيّر بين ما الشاشة تحمّل وما
///   الموظف يضغط، والفرق بين الاتنين طلاب اتقبلوا وهو مش قاصدهم.
const bulkSchema = z.object({
  body: z.object({
    action: z.enum(["approve", "reject"]),
    ids: z.array(idField).min(1).max(100),
    reason: z.string().trim().max(300).optional(),
  }),
});

const branchQuery = z.object({
  query: z.object({
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const linkActiveSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
  body: z.object({ is_active: z.boolean() }),
});

router.use(auth);

// ── الروابط ───────────────────────────────────────────────
// ⚠ لازم تبقى قبل "/:id/..." وإلا "link" هتتقري كـ id
//
// القراية والتغيير مش نفس الحاجة هنا:
//
//   الـ QR نفسه بيتطبع وبيتحط على الديسك قدام موظف الاستقبال،
//   وهو اللي بيوريه للطالب — فمنعه من **شوفه** مامنعش حد من
//   حاجة، بس خلّى الشاشة فاضية في وشه.
//
//   اللي خطر هو التدوير والإيقاف: التدوير بيبطّل كل QR مطبوع
//   في نفس اللحظة. ده فضل للمديرين.
router.get(
  "/link",
  validate(branchQuery),
  validateBranch({ required: true }),
  requireRole(...STAFF),
  getLink,
);

// ⚠ المديرين بس — ده بيبطّل كل QR مطبوع فورًا
router.post(
  "/link/rotate",
  validate(branchQuery),
  validateBranch({ required: true }),
  requireRole(...MANAGERS),
  rotateLink,
);

router.put(
  "/link",
  validate(linkActiveSchema),
  validateBranch({ required: true }),
  requireRole(...MANAGERS),
  setLinkActive,
);

// ── الطلبات ───────────────────────────────────────────────
// ⚠ بقت صلاحية (registrations) مش رتبة. الموافقة بتعمل حساب
//   طالب جديد بكود وQR — فمش كل موظف بيشوف الطلاب المفروض
//   يقدر يقبل. والصلاحية على الفرع، يعني أدمن فرع مايوافقش
//   على طلبات فرع تاني.
router.get(
  "/",
  validate(listSchema),
  validateBranch({ required: false }),
  requireBranchAccess("registrations"),
  list,
);

// ⚠ قبل "/:id" — من غير كده "bulk" هتتقري كـ id والـ Zod هيرفضها
router.post(
  "/bulk",
  validate(bulkSchema),
  validateBranch({ required: false }),
  requireBranchAccess("registrations"),
  bulk,
);

router.get(
  "/:id/options",
  validate(idParam),
  validateBranch({ required: false }),
  requireBranchAccess("registrations"),
  options,
);

router.put(
  "/:id",
  validate(updateSchema),
  validateBranch({ required: false }),
  requireBranchAccess("registrations"),
  update,
);

router.post(
  "/:id/approve",
  validate(idParam),
  validateBranch({ required: false }),
  requireBranchAccess("registrations"),
  approve,
);

router.post(
  "/:id/reject",
  validate(rejectSchema),
  validateBranch({ required: false }),
  requireBranchAccess("registrations"),
  reject,
);

module.exports = router;
