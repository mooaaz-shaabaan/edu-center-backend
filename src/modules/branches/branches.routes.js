// src/modules/branches/branches.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getBranches, createBranch, updateBranch, deleteBranch, getBranchStats,
  getRooms, createRoom, updateRoom,
} = require("./branches.controller");

/// إنشاء وحذف الفرع — الأونر والسوبر أدمن بس.
/// ⚠ كانت MANAGERS (بتشمل admin)، في حين إن شاشة الفروع في الفلاتر
///   بتقفل زرار الإضافة والحذف على isOwner || isSuperAdmin.
///   يعني الـ admin كان يقدر ينشئ ويحذف فروع من الـ API مباشرة
///   رغم إن الواجهة مخفياها عنه.
const BRANCH_OWNERS = ["owner", "super_admin"];

const idField = z.coerce.number().int().positive();

const idParam = z.object({ params: z.object({ id: idField }) });

/// الـ query params بتوصل نصوص دايماً — "false" نص صحيح و Boolean("false") = true
/// فلازم تحويل صريح
const boolParam = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

/// ⚠ GET /branches كان من غير validate خالص، يعني req.validated
///   بيبقى undefined وأي باراميتر في الـ query بيتجاهل.
const listBranchesSchema = z.object({
  query: z.object({
    // من غيرها → كل الفروع (الشغّال والموقوف)
    is_active: boolParam,
    // الإحصائيات جوه نفس الطلب — للمديرين بس (متفحوصة في الكنترولر)
    with_stats: boolParam,
    tenant_id: idField.optional(), // للـ super_admin
  }),
});

const createBranchSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(150),
    address: z.string().max(300).nullable().optional(),
    phone: z.string().max(20).nullable().optional(),
    tenant_id: idField.optional(), // للـ super_admin
  }),
});

const updateBranchSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    address: z.string().max(300).nullable().optional(),
    phone: z.string().max(20).nullable().optional(),
    is_active: z.boolean().optional(),
  }),
});

const roomsListSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const createRoomSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100),
    capacity: z.coerce.number().int().positive().max(10000).optional(),
    branch_id: idField,
    tenant_id: idField.optional(),
  }),
});

const updateRoomSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    capacity: z.coerce.number().int().positive().max(10000).optional(),
  }),
});

router.use(auth);

// ── Branches ──────────────────────────────────────────────
router.get(
  "/branches",
  validate(listBranchesSchema),
  requireRole(...STAFF),
  getBranches
);

router.get(
  "/branches/:id/stats",
  validate(idParam),
  requireRole(...MANAGERS), // الإحصائيات المالية: المديرين بس
  getBranchStats
);

router.post(
  "/branches",
  validate(createBranchSchema),
  requireRole(...BRANCH_OWNERS),
  withNotify(createBranch, "branches_updated")
);

// التعديل (الاسم/العنوان/الإيقاف) لسه للمديرين — الأدمن بيحتاجه
router.put(
  "/branches/:id",
  validate(updateBranchSchema),
  requireRole(...MANAGERS),
  withNotify(updateBranch, "branches_updated")
);

router.delete(
  "/branches/:id",
  validate(idParam),
  requireRole(...BRANCH_OWNERS),
  withNotify(deleteBranch, "branches_updated")
);

// ── Rooms ─────────────────────────────────────────────────
router.get(
  "/rooms",
  validate(roomsListSchema),
  requireRole(...STAFF),
  getRooms
);

router.post(
  "/rooms",
  validate(createRoomSchema),
  requireRole(...MANAGERS),
  withNotify(createRoom, "branches_updated")
);

router.put(
  "/rooms/:id",
  validate(updateRoomSchema),
  requireRole(...MANAGERS),
  withNotify(updateRoom, "branches_updated")
);

module.exports = router;