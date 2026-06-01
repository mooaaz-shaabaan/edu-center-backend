// src/modules/payments/payments.controller.js
const prisma = require("../../config/db");

// ═══════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════

// ── GET /api/payments ─────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { student_id, shift_id, page = 1, limit = 20 } = req.query;

    const where = {};
    if (student_id) where.student_id = parseInt(student_id);
    if (shift_id) where.shift_id = parseInt(shift_id);

    if (req.query.date) {
      const d = new Date(req.query.date);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      where.paid_at = { gte: d, lt: next };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { paid_at: "desc" },
        include: {
          student: { select: { id: true, name: true } },
          shift: { select: { id: true, opened_at: true } },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({
      success: true,
      data: payments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments ────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const { student_id, shift_id, amount, notes } = req.body;

    if (!student_id || !amount) {
      return res.status(400).json({
        success: false,
        message: "student_id and amount are required.",
      });
    }

    // توليد رقم إيصال
    const receipt_number = `RCP-${Date.now()}`;

    const payment = await prisma.payment.create({
      data: {
        student_id: parseInt(student_id),
        shift_id: shift_id ? parseInt(shift_id) : null,
        amount: parseFloat(amount),
        receipt_number,
        notes: notes || null,
        sync_status: "synced",
      },
      include: {
        student: { select: { id: true, name: true } },
        shift: { select: { id: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully.",
      data: payment,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/:id/receipt ─────────────────────────
// const getReceipt = async (req, res, next) => {
//   try {
//     const payment = await prisma.payment.findUnique({
//       where: { id: parseInt(req.params.id) },
//       include: {
//         student: { select: { id: true, name: true, phone: true } },
//       },
//     });

//     if (!payment) {
//       return res.status(404).json({ success: false, message: "Payment not found." });
//     }

//     const { generateReceipt } = require("../../utils/pdfGenerator");

//     const pdfBuffer = await generateReceipt({
//       receipt_number: payment.receipt_number,
//       student_name: payment.student.name,
//       student_phone: payment.student.phone,
//       amount: payment.amount,
//       paid_at: payment.paid_at,
//       notes: payment.notes,
//       center_name: process.env.APP_NAME || "Edu Center",
//     });

//     res.setHeader("Content-Type", "application/pdf");
//     res.setHeader("Content-Disposition", `attachment; filename=receipt-${payment.receipt_number}.pdf`);
//     res.send(pdfBuffer);
//   } catch (err) {
//     next(err);
//   }
// };

// استبدل الـ getReceipt function دي في payments.controller.js

const getReceipt = async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        student: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }

    const { generateReceipt } = require("../../utils/pdfGenerator");

    const html = generateReceipt({
      receipt_number: payment.receipt_number,
      student_name: payment.student.name,
      student_phone: payment.student.phone,
      amount: payment.amount,
      paid_at: payment.paid_at,
      notes: payment.notes,
      center_name: process.env.APP_NAME || "Edu Center",
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// CASH TRANSACTIONS
// ═══════════════════════════════════════════

// ── POST /api/payments/cash ───────────────────────────────
const cashTransaction = async (req, res, next) => {
  try {
    const { shift_id, type, amount, reason } = req.body;

    if (!type || !amount) {
      return res.status(400).json({
        success: false,
        message: "type and amount are required.",
      });
    }

    if (!["deposit", "withdrawal"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "type must be 'deposit' or 'withdrawal'.",
      });
    }

    const transaction = await prisma.cashTransaction.create({
      data: {
        shift_id: shift_id ? parseInt(shift_id) : null,
        type,
        amount: parseFloat(amount),
        reason: reason || null,
        sync_status: "synced",
      },
    });

    res.status(201).json({
      success: true,
      message: `Cash ${type} recorded successfully.`,
      data: transaction,
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// INSTALLMENTS
// ═══════════════════════════════════════════

// ── GET /api/payments/installments ───────────────────────
const getInstallments = async (req, res, next) => {
  try {
    const { student_id, status } = req.query;

    const where = {};
    if (student_id) where.student_id = parseInt(student_id);
    if (status) where.status = status;

    const installments = await prisma.installment.findMany({
      where,
      orderBy: { due_date: "asc" },
      include: {
        student: { select: { id: true, name: true, parent_phone: true } },
        enrollment: { include: { course: { select: { id: true, name: true } } } },
      },
    });

    res.json({ success: true, data: installments });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/installments/overdue ────────────────
const getOverdue = async (req, res, next) => {
  try {
    const overdue = await prisma.installment.findMany({
      where: {
        status: { in: ["unpaid", "partial"] },
        due_date: { lt: new Date() },
      },
      orderBy: { due_date: "asc" },
      include: {
        student: { select: { id: true, name: true, parent_phone: true } },
        enrollment: { include: { course: { select: { id: true, name: true } } } },
      },
    });

    res.json({ success: true, data: overdue });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/payments/installments/:id ───────────────────
const updateInstallment = async (req, res, next) => {
  try {
    const { status, paid_at } = req.body;

    const installment = await prisma.installment.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(status && { status }),
        ...(paid_at && { paid_at: new Date(paid_at) }),
        ...(status === "paid" && !paid_at && { paid_at: new Date() }),
      },
    });

    res.json({ success: true, message: "Installment updated.", data: installment });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// EXPENSES
// ═══════════════════════════════════════════

// ── GET /api/payments/expenses ────────────────────────────
const getExpenses = async (req, res, next) => {
  try {
    const { shift_id, category } = req.query;

    const where = {};
    if (shift_id) where.shift_id = parseInt(shift_id);
    if (category) where.category = category;

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { expense_date: "desc" },
      include: { shift: { select: { id: true, opened_at: true } } },
    });

    res.json({ success: true, data: expenses });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments/expenses ───────────────────────────
const createExpense = async (req, res, next) => {
  try {
    const { shift_id, category, description, amount } = req.body;

    if (!category || !amount) {
      return res.status(400).json({
        success: false,
        message: "category and amount are required.",
      });
    }

    const expense = await prisma.expense.create({
      data: {
        shift_id: shift_id ? parseInt(shift_id) : null,
        category,
        description: description || null,
        amount: parseFloat(amount),
        sync_status: "synced",
      },
    });

    res.status(201).json({
      success: true,
      message: "Expense recorded.",
      data: expense,
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/payments/expenses/:id ───────────────────────
const updateExpense = async (req, res, next) => {
  try {
    const { category, description, amount } = req.body;

    const expense = await prisma.expense.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(category && { category }),
        ...(description !== undefined && { description }),
        ...(amount && { amount: parseFloat(amount) }),
      },
    });

    res.json({ success: true, message: "Expense updated.", data: expense });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/payments/expenses/:id ────────────────────
const deleteExpense = async (req, res, next) => {
  try {
    await prisma.expense.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true, message: "Expense deleted." });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll, create, getReceipt, cashTransaction,
  getInstallments, getOverdue, updateInstallment,
  getExpenses, createExpense, updateExpense, deleteExpense,
};
