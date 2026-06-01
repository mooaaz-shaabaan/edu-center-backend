// src/modules/reports/reports.controller.js
const prisma = require("../../config/db");

// ── GET /api/reports/revenue ──────────────────────────────
// إيرادات يومية أو شهرية
const getRevenue = async (req, res, next) => {
  try {
    const { period = "monthly", month, year } = req.query;

    const now = new Date();
    const y = parseInt(year) || now.getFullYear();
    const m = parseInt(month) || now.getMonth() + 1;

    let from, to;

    if (period === "daily") {
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 1);
    } else {
      from = new Date(y, 0, 1);
      to = new Date(y + 1, 0, 1);
    }

    const payments = await prisma.payment.findMany({
      where: { paid_at: { gte: from, lt: to } },
      select: { amount: true, paid_at: true },
      orderBy: { paid_at: "asc" },
    });

    // تجميع حسب اليوم أو الشهر
    const grouped = {};
    for (const p of payments) {
      const date = new Date(p.paid_at);
      const key =
        period === "daily"
          ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
          : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

      if (!grouped[key]) grouped[key] = 0;
      grouped[key] += parseFloat(p.amount);
    }

    const total = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    res.json({
      success: true,
      data: {
        period,
        total,
        breakdown: Object.entries(grouped).map(([date, amount]) => ({ date, amount })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/profit ───────────────────────────────
// صافي الربح (إيرادات - مصروفات)
const getProfit = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const now = new Date();
    const y = parseInt(year) || now.getFullYear();
    const m = parseInt(month) || now.getMonth() + 1;

    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 1);

    const [payments, expenses, cashIn, cashOut] = await Promise.all([
      prisma.payment.aggregate({
        where: { paid_at: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { expense_date: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
      prisma.cashTransaction.aggregate({
        where: { type: "deposit", created_at: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
      prisma.cashTransaction.aggregate({
        where: { type: "withdrawal", created_at: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome = Number(payments._sum.amount || 0) + Number(cashIn._sum.amount || 0);
    const totalExpenses = Number(expenses._sum.amount || 0) + Number(cashOut._sum.amount || 0);
    const netProfit = totalIncome - totalExpenses;

    res.json({
      success: true,
      data: {
        month: m,
        year: y,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: netProfit,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/attendance ───────────────────────────
// نسبة حضور لكل فصل
const getAttendance = async (req, res, next) => {
  try {
    const { course_id, date } = req.query;

    const where = {};
    if (date) {
      const d = new Date(date);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      where.date = { gte: d, lt: next };
    }

    const records = await prisma.attendance.groupBy({
      by: ["status"],
      where,
      _count: { status: true },
    });

    const total = records.reduce((sum, r) => sum + r._count.status, 0);
    const present = records.find((r) => r.status === "present")?._count.status || 0;
    const percentage = total > 0 ? ((present / total) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        total,
        present,
        absent: records.find((r) => r.status === "absent")?._count.status || 0,
        late: records.find((r) => r.status === "late")?._count.status || 0,
        attendance_percentage: `${percentage}%`,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/top-courses ──────────────────────────
// أكثر الكورسات إيراداً
const getTopCourses = async (req, res, next) => {
  try {
    const courses = await prisma.course.findMany({
      include: {
        enrollments: {
          include: {
            installments: { where: { status: "paid" } },
          },
        },
      },
    });

    const result = courses.map((course) => {
      const revenue = course.enrollments.reduce((sum, e) => {
        return sum + e.installments.reduce((s, i) => s + parseFloat(i.amount), 0);
      }, 0);

      return {
        id: course.id,
        name: course.name,
        enrollments: course.enrollments.length,
        revenue,
      };
    });

    result.sort((a, b) => b.revenue - a.revenue);

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/renewals ─────────────────────────────
// معدل تجديد الاشتراكات
const getRenewals = async (req, res, next) => {
  try {
    const total = await prisma.enrollment.count();
    const active = await prisma.enrollment.count({
      where: {
        OR: [
          { end_date: null },
          { end_date: { gte: new Date() } },
        ],
      },
    });

    const expired = total - active;
    const renewalRate = total > 0 ? ((active / total) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        total_enrollments: total,
        active,
        expired,
        renewal_rate: `${renewalRate}%`,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/students ─────────────────────────────
// أداء طالب معين
const getStudentReport = async (req, res, next) => {
  try {
    const { student_id } = req.query;

    if (!student_id) {
      return res.status(400).json({ success: false, message: "student_id is required." });
    }

    const [student, attendance, payments, grades] = await Promise.all([
      prisma.student.findUnique({
        where: { id: parseInt(student_id) },
        include: {
          enrollments: { include: { course: true } },
        },
      }),
      prisma.attendance.groupBy({
        by: ["status"],
        where: { student_id: parseInt(student_id) },
        _count: { status: true },
      }),
      prisma.payment.aggregate({
        where: { student_id: parseInt(student_id) },
        _sum: { amount: true },
      }),
      prisma.studentGrade.findMany({
        where: { student_id: parseInt(student_id) },
        include: { exam: { select: { title: true, exam_date: true } } },
      }),
    ]);

    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    const totalAttendance = attendance.reduce((sum, r) => sum + r._count.status, 0);
    const present = attendance.find((r) => r.status === "present")?._count.status || 0;

    res.json({
      success: true,
      data: {
        student: {
          id: student.id,
          name: student.name,
          enrollments: student.enrollments,
        },
        attendance: {
          total: totalAttendance,
          present,
          absent: attendance.find((r) => r.status === "absent")?._count.status || 0,
          percentage: totalAttendance > 0 ? `${((present / totalAttendance) * 100).toFixed(1)}%` : "0%",
        },
        total_paid: payments._sum.amount || 0,
        grades,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getRevenue,
  getProfit,
  getAttendance,
  getTopCourses,
  getRenewals,
  getStudentReport,
};
