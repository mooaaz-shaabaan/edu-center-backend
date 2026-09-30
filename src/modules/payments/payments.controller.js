// src/modules/payments/payments.controller.js
const prisma = require("../../config/db");
const { tenantWhere, requireTenantId, assertSameTenant, assertShiftInTenant } = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const { resolveShiftId } = require("../../core/currentShift");
const { resolveDrawerId, sendDrawerError } = require("../../core/drawerScope");

const genReceipt = (prefix = "RCP") => {
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${Date.now()}-${rand}`;
};

// ═══════════════════════════════════════════
// حراسة مشتركة
// ═══════════════════════════════════════════

/**
 * الفروع المسموحة.
 *
 * `requireBranchAccess` بيحطّ `req.allowedBranchIds` (null = كل الفروع)،
 * بس بنرجع لـ `getAllowedBranchIds` لو الراوت مستخدمش الميدلوير ده —
 * فالفلترة مابتسقطش بصمت لو حد غيّر الحراسة بعدين.
 */
const allowedBranches = (req) =>
  req.allowedBranchIds !== undefined
    ? req.allowedBranchIds
    : getAllowedBranchIds(req.user);

/**
 * ⚠ كان `if (req.branchId) where.branch_id = req.branchId;` وبس.
 *
 *   يعني لما الشاشة ماتبعتش `branch_id` (والفلاتر بيبعتها، بس أي
 *   طلب من برّه البرنامج مش مضطر)، الفلتر كان بيتشال خالص والموظف
 *   يشوف **مدفوعات ومصروفات كل فروع السنتر**.
 */
const scopeToBranch = (req, where) => {
  if (req.branchId) {
    where.branch_id = req.branchId;
    return where;
  }
  const allowed = allowedBranches(req);
  if (allowed) where.branch_id = { in: allowed };
  return where;
};

/** صف من فرع مش من فروعه → 404 (مش 403، عشان ما نأكّدش إنه موجود) */
const assertBranchVisible = (req, branchId) => {
  const allowed = allowedBranches(req);
  if (allowed && !allowed.includes(branchId)) {
    const err = new Error("Record not found.");
    err.status = 404;
    throw err;
  }
};

/**
 * الوردية + الدرج لأي حركة مالية.
 *
 * ⚠ الوردية **مش** شرط. الأونر والأدمن مابيفتحوش ورديات، وكانت
 *   حركاتهم بتتسجّل بـ `shift_id: null` — ومن غير وردية مكانش فيه
 *   درج، فالفلوس تدخل الصندوق أو تخرج منه وحسبة الدرج ماتشوفهاش،
 *   وأول جرد بعدها يطلّع فرق باسم اللي مالوش ذنب.
 *
 *   الدرج بقى بيتحدد لوحده: من الوردية لو فيه، وإلا من الفرع
 *   (أو المستخدم يختاره لو الفرع فيه أكتر من درج).
 */
const resolveMoneyTarget = async (req, tenantId, rawShiftId) => {
  const shiftId = await resolveShiftId(prisma, req, rawShiftId);
  const drawerId = await resolveDrawerId(prisma, {
    tenantId,
    branchId: req.branchId,
    drawerId: req.validated?.body?.drawer_id ?? null,
    shiftId,
  });
  return { shiftId, drawerId };
};

// ═══════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════

// ── GET /api/payments ─────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { student_id, shift_id, date } = req.validated.query;
    const page = req.validated.query.page || 1;
    const limit = req.validated.query.limit || 20;

    const where = scopeToBranch(req, { ...tenantWhere(req) });
    if (student_id) where.student_id = student_id;
    if (shift_id) where.shift_id = shift_id;
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      where.paid_at = { gte: d, lt: next };
    }

    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { paid_at: "desc" },
        include: {
          student: { select: { id: true, name: true } },
          shift: { select: { id: true, opened_at: true } },
          created_by_user: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({
      success: true,
      data: payments,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments ────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const { student_id, shift_id, amount, notes } = req.validated.body;
    const tenantId = requireTenantId(req);
    await assertShiftInTenant(prisma, shift_id, tenantId);
    const { shiftId, drawerId } = await resolveMoneyTarget(req, tenantId, shift_id);

    // الطالب لازم تابع لنفس السنتر
    const student = await prisma.student.findFirst({
      where: { id: student_id, tenant_id: tenantId },
      select: { id: true },
    });
    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const payment = await prisma.payment.create({
      data: {
        tenant_id: tenantId, // ← الختم
        student_id,
        shift_id: shiftId,
        drawer_id: drawerId, // ← الصندوق اللي الفلوس دخلته
        branch_id: req.branchId, // ← فرع القبض
        kind: "fee",
        amount,
        receipt_number: genReceipt("RCP"),
        notes: notes || null,
        sync_status: "synced",
        created_by: req.user.id,
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
    sendDrawerError(res, err, next);
  }
};

// ── GET /api/payments/:id/receipt ─────────────────────────
const getReceipt = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { student: { select: { id: true, name: true, phone: true } } },
    });

    // بيرمي 404 لو مش موجود أو من سنتر تاني
    assertSameTenant(req, payment);

    // ⚠ كان الفحص على السنتر بس — يعني أي موظف يقدر يطبع إيصال أي
    //   دفعة في السنتر كله، وفيه اسم الطالب وتليفونه.
    assertBranchVisible(req, payment.branch_id);

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

// ── GET /api/payments/cash ────────────────────────────────
const getCash = async (req, res, next) => {
  try {
    const { date } = req.validated.query;
    const where = scopeToBranch(req, { ...tenantWhere(req) });

    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      where.created_at = { gte: d, lt: next };
    }

    const transactions = await prisma.cashTransaction.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: {
        created_by_user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: transactions });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments/cash ───────────────────────────────
const cashTransaction = async (req, res, next) => {
  try {
    const { shift_id, type, amount, reason } = req.validated.body;
    const tenantId = requireTenantId(req);
    await assertShiftInTenant(prisma, shift_id, tenantId);
    const { shiftId, drawerId } = await resolveMoneyTarget(req, tenantId, shift_id);

    const transaction = await prisma.cashTransaction.create({
      data: {
        tenant_id: tenantId, // ← الختم
        shift_id: shiftId,
        drawer_id: drawerId,
        branch_id: req.branchId,
        type,
        amount,
        reason: reason || null,
        sync_status: "synced",
        created_by: req.user.id,
      },
    });

    res.status(201).json({
      success: true,
      message: `Cash ${type} recorded successfully.`,
      data: transaction,
    });
  } catch (err) {
    sendDrawerError(res, err, next);
  }
};

// ═══════════════════════════════════════════
// EXPENSES
// ═══════════════════════════════════════════

// ── GET /api/payments/expenses ────────────────────────────
const getExpenses = async (req, res, next) => {
  try {
    const { shift_id, category } = req.validated.query;

    const where = scopeToBranch(req, { ...tenantWhere(req) });
    if (shift_id) where.shift_id = shift_id;
    if (category) where.category = category;

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { expense_date: "desc" },
      include: {
        shift: { select: { id: true, opened_at: true } },
        created_by_user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: expenses });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments/expenses ───────────────────────────
const createExpense = async (req, res, next) => {
  try {
    const { shift_id, category, description, amount } = req.validated.body;
    const tenantId = requireTenantId(req);
    await assertShiftInTenant(prisma, shift_id, tenantId);
    const { shiftId, drawerId } = await resolveMoneyTarget(req, tenantId, shift_id);

    const expense = await prisma.expense.create({
      data: {
        tenant_id: tenantId, // ← الختم
        shift_id: shiftId,
        drawer_id: drawerId,
        branch_id: req.branchId,
        category,
        description: description || null,
        amount,
        sync_status: "synced",
        created_by: req.user.id,
      },
    });

    res.status(201).json({
      success: true,
      message: "Expense recorded.",
      data: expense,
    });
  } catch (err) {
    sendDrawerError(res, err, next);
  }
};

// ── PUT /api/payments/expenses/:id ───────────────────────
const updateExpense = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { category, description, amount } = req.validated.body;

    const existing = await prisma.expense.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        branch_id: true,
        amount: true,
        shift: { select: { id: true, closed_at: true } },
      },
    });
    assertSameTenant(req, existing);

    // ⚠ كان الفحص على السنتر بس — أدمن مقيّد بفرع كان يقدر يعدّل
    //   مصروفات فرع مش بتاعه
    assertBranchVisible(req, existing.branch_id);

    /**
     * ⚠ تغيير مبلغ مصروف على وردية **مقفولة** بيكسر الحسبة:
     *   الوردية اتقفلت بـ `net_total` محسوب، والدرج اتعدّ على أساسه.
     *   لو المبلغ اتغيّر بعدين، تقرير الوردية والجرد بيقولوا رقمين
     *   مختلفين ومفيش أثر للتغيير.
     *
     *   المصروف الغلط على وردية مقفولة بيتصحّح بمصروف/إيداع مضاد
     *   على الوردية الحالية، مش بتعديل التاريخ.
     */
    if (amount !== undefined &&
        existing.shift?.closed_at &&
        Number(amount) !== Number(existing.amount)) {
      return res.status(400).json({
        success: false,
        code: "SHIFT_CLOSED",
        message:
          "مينفعش تغيّر مبلغ مصروف على وردية مقفولة — سجّل حركة مضادة على وردية النهاردة.",
      });
    }

    const expense = await prisma.expense.update({
      where: { id },
      data: {
        ...(category !== undefined && { category }),
        ...(description !== undefined && { description }),
        ...(amount !== undefined && { amount }),
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
    const id = req.validated.params.id;

    const existing = await prisma.expense.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        branch_id: true,
        shift: { select: { id: true, closed_at: true } },
      },
    });
    assertSameTenant(req, existing);
    assertBranchVisible(req, existing.branch_id);

    // نفس سبب التعديل فوق — الحذف من وردية مقفولة بيغيّر التاريخ
    if (existing.shift?.closed_at) {
      return res.status(400).json({
        success: false,
        code: "SHIFT_CLOSED",
        message:
          "مينفعش تحذف مصروف على وردية مقفولة — سجّل إيداع مضاد على وردية النهاردة.",
      });
    }

    await prisma.expense.delete({ where: { id } });
    res.json({ success: true, message: "Expense deleted." });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll, create, getReceipt,
  getCash, cashTransaction,
  getExpenses, createExpense, updateExpense, deleteExpense,
};