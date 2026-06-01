// src/modules/shifts/shifts.controller.js
const prisma = require("../../config/db");

// ── POST /api/shifts/open ─────────────────────────────────
const openShift = async (req, res, next) => {
  try {
    // تأكد مفيش shift مفتوحة للموظف ده
    const existing = await prisma.shift.findFirst({
      where: {
        user_id: req.user.id,
        closed_at: null,
      },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already have an open shift. Please close it first.",
        data: existing,
      });
    }

    const shift = await prisma.shift.create({
      data: {
        user_id: req.user.id,
        branch_id: req.user.branch_id,
      },
      include: {
        user: { select: { id: true, name: true, role: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: "Shift opened successfully.",
      data: shift,
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/shifts/close ────────────────────────────────
const closeShift = async (req, res, next) => {
  try {
    // جيب الـ shift المفتوحة
    const shift = await prisma.shift.findFirst({
      where: { user_id: req.user.id, closed_at: null },
    });

    if (!shift) {
      return res.status(400).json({
        success: false,
        message: "No open shift found.",
      });
    }

    // احسب الإجماليات
    const [payments, expenses, cashIn, cashOut] = await Promise.all([
      prisma.payment.aggregate({
        where: { shift_id: shift.id },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { shift_id: shift.id },
        _sum: { amount: true },
      }),
      prisma.cashTransaction.aggregate({
        where: { shift_id: shift.id, type: "deposit" },
        _sum: { amount: true },
      }),
      prisma.cashTransaction.aggregate({
        where: { shift_id: shift.id, type: "withdrawal" },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome =
      Number(payments._sum.amount || 0) + Number(cashIn._sum.amount || 0);
    const totalExpenses =
      Number(expenses._sum.amount || 0) + Number(cashOut._sum.amount || 0);
    const netTotal = totalIncome - totalExpenses;

    // احسب عدد الطلاب اللي حضروا
    const attendanceCount = await prisma.attendance.count({
      where: { shift_id: shift.id, status: "present" },
    });

    // اغلق الـ shift
    const closed = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        closed_at: new Date(),
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_total: netTotal,
        sync_status: "synced",
      },
      include: {
        user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    res.json({
      success: true,
      message: "Shift closed successfully.",
      data: {
        shift: closed,
        report: {
          total_income: totalIncome,
          total_expenses: totalExpenses,
          net_total: netTotal,
          students_attended: attendanceCount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/shifts (Admin — كل الجلسات) ─────────────────
const getAll = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [shifts, total] = await Promise.all([
      prisma.shift.findMany({
        skip,
        take: parseInt(limit),
        orderBy: { opened_at: "desc" },
        include: {
          user: { select: { id: true, name: true, role: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
      prisma.shift.count(),
    ]);

    res.json({
      success: true,
      data: shifts,
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

// ── GET /api/shifts/mine (جلساتي أنا بس) ────────────────
const getMine = async (req, res, next) => {
  try {
    const shifts = await prisma.shift.findMany({
      where: { user_id: req.user.id },
      orderBy: { opened_at: "desc" },
      include: {
        branch: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: shifts });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/shifts/current (الجلسة المفتوحة دلوقتي) ─────
const getCurrent = async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({
      where: { user_id: req.user.id, closed_at: null },
      include: {
        user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: "No open shift found.",
      });
    }

    res.json({ success: true, data: shift });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/shifts/:id/report ────────────────────────────
const getReport = async (req, res, next) => {
  try {
    const shiftId = parseInt(req.params.id);

    const [shift, studentsAdded] = await Promise.all([
      prisma.shift.findUnique({
        where: { id: shiftId },
        include: {
          user: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
          payments: { include: { student: { select: { id: true, name: true } } } },
          expenses: true,
          cash_transactions: true,
          attendance: { include: { student: { select: { id: true, name: true } } } },
        },
      }),
      prisma.student.count({ where: { shift_id: shiftId } }),
    ]);

    if (!shift) {
      return res.status(404).json({ success: false, message: "Shift not found." });
    }

    if (req.user.role === "receptionist" && shift.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "You can only view your own shifts." });
    }

    res.json({ success: true, data: { ...shift, studentsAdded } });
  } catch (err) {
    next(err);
  }
};

module.exports = { openShift, closeShift, getAll, getMine, getCurrent, getReport };
