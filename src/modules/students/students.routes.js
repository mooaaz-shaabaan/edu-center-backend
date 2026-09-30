// src/modules/students/students.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const validateBranch = require("../../middlewares/validateBranch");
const withNotify = require("../../core/withNotify");

const {
  getAll,
  getOne,
  create,
  update,
  remove,
  getQR,
  chargeWallet,
} = require("./students.controller");

// ── Schemas ───────────────────────────────────────────────
const idField = z.coerce.number().int().positive();
const money = z.coerce.number().positive().max(10000000);

const idParam = z.object({ params: z.object({ id: idField }) });

/// ⚠ باراميترات الـ query بتوصل نصوص دايماً، و `Boolean("false")`
///   بترجّع `true` — فـ `z.coerce.boolean()` بيخلّي "false" تبقى
///   true. لازم تحويل صريح. (نفس الفخ اللي كان في branches.routes)
const boolParam = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

const listSchema = z.object({
  query: z.object({
    name: z.string().max(100).optional(),
    branch_id: idField.optional(),
    course_id: idField.optional(),
    tenant_id: idField.optional(), // للـ super_admin

    all_branches: boolParam,

    /// ⚠ من غير السطر ده الـ Zod بيرمي الباراميتر بصمت —
    ///   لا بيرجّع خطأ ولا بيوصل للكنترولر، فشاشة "الموقوفين"
    ///   بترجع فاضية وكأن مفيش طلاب موقوفين.
    ///
    ///   مفيش → الشغّالين بس · "false" → الموقوفين · "all" → الاتنين
    is_active: z.enum(["true", "false", "all"]).optional(),

    page: z.coerce.number().int().positive().max(10000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

const createSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(150),
    phone: z.string().trim().min(1).max(20),
    parent_phone: z.string().trim().min(1).max(20),
    alt_phone: z.string().max(20).nullable().optional(),
    branch_id: idField,
    shift_id: idField.optional(),
    wallet_enabled: z.boolean().optional(),
    tenant_id: idField.optional(), // للـ super_admin
  }),
});

const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    phone: z.string().trim().min(1).max(20).optional(),
    parent_phone: z.string().trim().min(1).max(20).optional(),
    alt_phone: z.string().max(20).nullable().optional(),

    /// ⚠ وجوده في الـ body معناه "انقل الطالب للفرع ده".
    ///   الـ ApiClient في فلاتر كان بيحقنه في كل PUT، فأي تعديل
    ///   (تفعيل محفظة، تغيير تليفون) كان بينقل الطالب لفرع الموظف.
    ///   الحقن بقى للـ POST بس — سايبينه هنا عشان شاشة التعديل
    ///   لسه محتاجاه لما المستخدم يختار الفرع بإيده.
    branch_id: idField.optional(),

    is_active: z.boolean().optional(),
    photo: z.string().nullable().optional(),
    wallet_enabled: z.boolean().optional(),
  }),
});

const chargeSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    amount: money,
    shift_id: idField.optional(),
    // الفرع فيه أكتر من درج واللي بيشحن مالوش وردية → الشاشة بتختار
    drawer_id: idField.optional(),
    branch_id: idField.optional(), // ← الـ interceptor بيحقنه
    tenant_id: idField.optional(),
  }),
});

router.use(auth);

router.get("/", validate(listSchema), requireRole(...STAFF), getAll);

router.get("/:id", validate(idParam), requireRole(...STAFF), getOne);

router.get("/:id/qr", validate(idParam), requireRole(...STAFF), getQR);

router.post(
  "/",
  validate(createSchema),
  requireRole(...STAFF),
  withNotify(create, ["students_updated", "payments_updated"]),
);

router.put(
  "/:id",
  validate(updateSchema),
  requireRole(...STAFF),
  withNotify(update, ["students_updated"]),
);

router.delete(
  "/:id",
  validate(idParam),
  requireRole(...MANAGERS), // admin بس
  withNotify(remove, ["students_updated"]),
);

/// شحن المحفظة — فلوس بتدخل الدرج.
///
/// ⚠ `validateBranch` مكانش موجود هنا، فـ `req.branchId` كان بيفضل
///   `undefined`. ونتيجتها في `resolveShiftId`:
///
///     const mine = {
///       user_id: req.user.id,
///       closed_at: null,
///       ...(req.branchId ? { branch_id: req.branchId } : {}),  ← الشرط بيتشال
///     };
///
///   يعني الفلوس كانت ممكن تدخل درج **أي** وردية مفتوحة لليوزر
///   حتى لو في فرع تاني خالص. ومكانش فيه طريقة السيرفر يعرف بيها
///   الموظف واقف فين.
router.post(
  "/:id/wallet/charge",
  validate(chargeSchema),
  validateBranch({ required: true }),
  requireRole(...STAFF),
  withNotify(chargeWallet, ["payments_updated", "students_updated"]),
);

module.exports = router;
