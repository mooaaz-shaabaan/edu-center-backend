// src/modules/payments/payments.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF } = require("../../middlewares/rbac");
const { requireBranchAccess } = require("../../middlewares/rbac");
const validateBranch = require("../../middlewares/validateBranch");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getAll, create, getReceipt,
  getCash, cashTransaction,
  getExpenses, createExpense, updateExpense, deleteExpense,
} = require("./payments.controller");

const idField = z.coerce.number().int().positive();
const money = z.coerce.number().positive().max(10000000);

/// الفرع فيه أكتر من درج واللي بيسجّل مالوش وردية → الشاشة بتختار الدرج.
/// لو الفرع فيه درج واحد، السيرفر بيحدده لوحده ومفيش داعي للحقل ده.
const drawerField = idField.optional();

const listSchema = z.object({
  query: z.object({
    student_id: idField.optional(),
    shift_id: idField.optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    date: z.string().optional(),
    page: z.coerce.number().int().positive().max(10000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

const createPaymentSchema = z.object({
  body: z.object({
    student_id: idField,
    shift_id: idField.optional(),
    drawer_id: drawerField,
    branch_id: idField,
    amount: money,
    notes: z.string().max(500).optional(),
    tenant_id: idField.optional(),
  }),
});

const receiptSchema = z.object({
  params: z.object({ id: idField }),
});

const cashListSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
    date: z.string().optional(),
  }),
});

const cashSchema = z.object({
  body: z.object({
    shift_id: idField.optional(),
    drawer_id: drawerField,
    branch_id: idField,
    type: z.enum(["deposit", "withdrawal"]),
    amount: money,
    reason: z.string().max(500).optional(),
    tenant_id: idField.optional(),
  }),
});

const expenseListSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    shift_id: idField.optional(),
    tenant_id: idField.optional(),
    category: z.string().max(100).optional(),
  }),
});

const createExpenseSchema = z.object({
  body: z.object({
    shift_id: idField.optional(),
    drawer_id: drawerField,
    branch_id: idField,
    category: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    amount: money,
    tenant_id: idField.optional(),
  }),
});

const updateExpenseSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    category: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    amount: money.optional(),
  }),
});

const deleteExpenseSchema = z.object({
  params: z.object({ id: idField }),
});

router.use(auth);


// ── PAYMENTS ──────────────────────────────────────────────
router.get(
  "/",
  validate(listSchema),
  validateBranch({ required: false }),
  requireRole(...STAFF),
  requireBranchAccess("payments"),
  getAll
);

router.post(
  "/",
  validate(createPaymentSchema),
  validateBranch({ required: true }),
  requireRole(...STAFF),
  requireBranchAccess("payments"),
  withNotify(create, ["payments_updated", "drawers_updated"])
);

router.get(
  "/:id/receipt",
  validate(receiptSchema),
  requireRole(...STAFF),
  requireBranchAccess("payments"),
  getReceipt
);

// ── CASH ──────────────────────────────────────────────────
router.get(
  "/cash",
  validate(cashListSchema),
  validateBranch({ required: false }),
  requireRole(...STAFF),
  requireBranchAccess("payments"),
  getCash
);

router.post(
  "/cash",
  validate(cashSchema),
  validateBranch({ required: true }),
  requireRole(...STAFF),
  requireBranchAccess("payments"),
  withNotify(cashTransaction, ["payments_updated", "drawers_updated"])
);

// ── EXPENSES ──────────────────────────────────────────────
router.get(
  "/expenses",
  validate(expenseListSchema),
  validateBranch({ required: false }),
  requireRole(...STAFF),
  requireBranchAccess("expenses"),
  getExpenses
);

router.post(
  "/expenses",
  validate(createExpenseSchema),
  validateBranch({ required: true }),
  requireRole(...STAFF),
  requireBranchAccess("expenses"),
  withNotify(createExpense, ["payments_updated", "drawers_updated"])
);

router.put(
  "/expenses/:id",
  validate(updateExpenseSchema),
  requireRole("admin", "super_admin", "owner"), // تعديل: المديرين بس
  requireBranchAccess("expenses"),
  withNotify(updateExpense, ["payments_updated", "drawers_updated"])
);

router.delete(
  "/expenses/:id",
  validate(deleteExpenseSchema),
  requireRole("admin", "super_admin", "owner"), // حذف: المديرين بس
  requireBranchAccess("expenses"),
  withNotify(deleteExpense, ["payments_updated", "drawers_updated"])
);

module.exports = router;