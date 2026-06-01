// src/modules/payments/payments.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const prisma = require("../../config/db");
const {
  getAll, create, getReceipt, cashTransaction,
  getInstallments, getOverdue, updateInstallment,
  getExpenses, createExpense, updateExpense, deleteExpense,
} = require("./payments.controller");

router.use(auth);

// ── Payments ──────────────────────────────────────────────
router.get("/",                       getAll);
router.post("/",                      create);
router.get("/:id/receipt",            getReceipt);

// ── Cash ──────────────────────────────────────────────────
router.get("/cash", async (req, res, next) => {
  try {
    const where = {};
    if (req.query.date) {
      const d = new Date(req.query.date);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      where.created_at = { gte: d, lt: next };
    }
    const transactions = await prisma.cashTransaction.findMany({
      where,
      orderBy: { created_at: "desc" },
    });
    res.json({ success: true, data: transactions });
  } catch (err) { next(err); }
});
router.post("/cash",                  cashTransaction);

// ── Installments ──────────────────────────────────────────
router.get("/installments",           getInstallments);
router.get("/installments/overdue",   getOverdue);
router.put("/installments/:id",       updateInstallment);

// ── Expenses ──────────────────────────────────────────────
router.get("/expenses",               getExpenses);
router.post("/expenses",              createExpense);
router.put("/expenses/:id",           updateExpense);
router.delete("/expenses/:id",        role("admin"), deleteExpense);

module.exports = router;