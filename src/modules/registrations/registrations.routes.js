// src/modules/registrations/registrations.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const {
  requireRole,
  MANAGERS,
  requireBranchAccess,
} = require("../../middlewares/rbac");
const validateBranch = require("../../middlewares/validateBranch");
const validate = require("../../middlewares/validate");

const {
  list,
  approve,
  reject,
  getLink,
  rotateLink,
  setLinkActive,
} = require("./registrations.controller");

const idField = z.coerce.number().int().positive();
const idParam = z.object({ params: z.object({ id: idField }) });

const listSchema = z.object({
  query: z.object({
    status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    page: z.coerce.number().int().positive().max(10000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

const rejectSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({ reason: z.string().trim().max(300).optional() }),
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
// المدير بس — الرابط ده هو الباب اللي أي حد بره السنتر ممكن
// يدخل منه، وتدويره بيبطّل الـ QR المطبوع على الديسك فوراً.
// مش شغل موظف استقبال.
router.get(
  "/link",
  validate(branchQuery),
  validateBranch({ required: true }),
  requireRole(...MANAGERS),
  getLink,
);

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