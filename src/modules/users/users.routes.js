// src/modules/users/users.routes.js - محدثة
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
  resolveTenantId,
} = require("../../core/tenant");

const usersController = require("./users.controller");

// ── Schemas ───────────────────────────────────────────────
const idField = z.coerce.number().int().positive();

const strongPassword = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128)
  .regex(/[a-zA-Z]/, "Password must contain a letter.")
  .regex(/[0-9]/, "Password must contain a number.");

const branchGrantSchema = z.union([
  idField,
  z.object({
    branch_id: idField,
    features: z.array(z.string()).optional(),
  }),
]);

const createUserSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, "name is required.").max(150),
    email: z.string().trim().toLowerCase().email("Invalid email.").max(255),
    password: strongPassword,
    role: z.enum(["owner", "admin", "receptionist"]),
    branch_id: idField.optional(),
    branches: z.array(branchGrantSchema).optional(), // ← بدل z.array(idField)
  }),
});

const updateUserSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Invalid email.")
      .max(255)
      .optional(),
    is_active: z.boolean().optional(),
    role: z.enum(["owner", "admin", "receptionist"]).optional(),
    branch_id: idField.nullable().optional(),
  }),
});

const passwordSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({ password: strongPassword }),
});

const branchAccessSchema = z.object({
  params: z.object({
    id: idField,
    branchId: idField,
  }),
  body: z
    .object({
      features: z.array(z.string()).optional(),
    })
    .optional()
    .default({}),
});

const userIdParamSchema = z.object({
  params: z.object({ id: idField }),
});

// ── Routes ────────────────────────────────────────────────
// كل المسارات: لازم login
router.use(auth);

// ── GET /api/users ────────────────────────────────────────
// الحصول على قائمة المستخدمين
router.get(
  "/",
  requireRole("owner", "admin", "super_admin"),
  usersController.getUsers,
);

// ── POST /api/users ───────────────────────────────────────
// إنشاء مستخدم جديد
router.post(
  "/",
  requireRole("owner", "admin", "super_admin"),
  validate(createUserSchema),
  withNotify(usersController.createUser, "users_updated"),
);

// ── PUT /api/users/:id ────────────────────────────────────
// تعديل المستخدم
router.put(
  "/:id",
  requireRole("owner", "admin", "super_admin"),
  validate(updateUserSchema),
  withNotify(usersController.updateUser, "users_updated"),
);

// ── PUT /api/users/:id/password ───────────────────────────
// تغيير كلمة المرور
router.put(
  "/:id/password",
  requireRole("owner", "admin", "super_admin"),
  validate(passwordSchema),
  withNotify(usersController.resetUserPassword, "users_updated"),
);

// ── GET /api/users/:id/branch-access ──────────────────────
// الحصول على صلاحيات الفروع للمستخدم
router.get(
  "/:id/branch-access",
  requireRole("owner", "admin", "super_admin"),
  validate(userIdParamSchema), // ← ضيف السطر ده
  usersController.getUserBranchAccess,
);

// ── PUT /api/users/:id/branch-access/:branchId ───────────
// تحديث صلاحيات فرع محدد
router.put(
  "/:id/branch-access/:branchId",
  requireRole("owner", "admin", "super_admin"),
  validate(branchAccessSchema),
  withNotify(usersController.updateUserBranchAccess, "users_updated"),
);

// ── DELETE /api/users/:id/branch-access/:branchId ────────
// حذف صلاحية فرع من مستخدم
router.delete(
  "/:id/branch-access/:branchId",
  requireRole("owner", "admin", "super_admin"),
  validate(branchAccessSchema),
  withNotify(usersController.removeUserBranchAccess, "users_updated"),
);

// ── POST /api/users/:id/archive ───────────────────────────
// أرشفة المستخدم (ساب الشغل)
router.post(
  "/:id/archive",
  requireRole("owner", "admin", "super_admin"),
  validate(userIdParamSchema),
  withNotify(usersController.archiveUser, "users_updated"),
);

// ── POST /api/users/:id/restore ───────────────────────────
// استرجاع مستخدم مؤرشف
router.post(
  "/:id/restore",
  requireRole("owner", "admin", "super_admin"),
  validate(userIdParamSchema),
  withNotify(usersController.restoreUser, "users_updated"),
);

module.exports = router;
