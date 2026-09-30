// src/modules/reports/reports.controller.js
const prisma = require("../../config/db");
const { tenantWhere, assertSameTenant } = require("../../core/tenant");

// ═══════════════════════════════════════════
// Helpers — حساب الدخل والمصروف بنفس طريقة تقفيل الجلسة
// (shifts.service → closeShiftWithTotals):
//   الدخل   = كل المدفوعات + إيداع الدرج
//   المصروف = المصروفات + سحب الدرج
// ═══════════════════════════════════════════

// نوع الدفعة من بادئة الإيصال (نفس اللي بيتكتب عند الإنشاء):
//   W-   → شحن محفظة        (students.controller → chargeWallet)
//   ATT- → كاش وقت الحضور   (attendance.controller → createAttendanceWithPayment)
//   غير كده → دفعة عادية   (payments.controller → create)
const paymentKind = (receipt) => {
  if (receipt?.startsWith("W-")) return "wallet_charge";
  if (receipt?.startsWith("ATT-")) return "attendance_cash";
  return "payment";
};

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "2026-09-22" → بداية اليوم بالتوقيت المحلي (مش UTC زي new Date("2026-09-22"))
const parseDay = (str) => {
  const [y, m, d] = String(str).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
};

/**
 * بيجمع كل العمليات المالية في فترة — مشترك بين التقرير والداشبورد
 */
const collectFinancials = async (req, from, to, branchId) => {
  const base = { ...tenantWhere(req) };
  if (branchId) base.branch_id = branchId;

  const [payments, cash, expenses, attendance] = await Promise.all([
    prisma.payment.findMany({
      where: { ...base, paid_at: { gte: from, lt: to } },
      select: {
        id: true,
        amount: true,
        paid_at: true,
        receipt_number: true,
        notes: true,
        student: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { paid_at: "asc" },
    }),
    prisma.cashTransaction.findMany({
      where: { ...base, created_at: { gte: from, lt: to } },
      select: {
        id: true,
        type: true,
        amount: true,
        reason: true,
        created_at: true,
        branch: { select: { id: true, name: true } },
      },
      orderBy: { created_at: "asc" },
    }),
    prisma.expense.findMany({
      where: { ...base, expense_date: { gte: from, lt: to } },
      select: {
        id: true,
        category: true,
        description: true,
        amount: true,
        expense_date: true,
        branch: { select: { id: true, name: true } },
      },
      orderBy: { expense_date: "asc" },
    }),
    prisma.attendance.groupBy({
      by: ["status"],
      where: { ...base, date: { gte: from, lt: to } },
      _count: { status: true },
      _sum: { wallet_debited: true, cash_paid: true },
    }),
  ]);

  const totals = {
    payments: 0, // دفعات عادية
    wallet_charges: 0, // شحن محفظة
    attendance_cash: 0, // كاش وقت الحضور
    cash_deposits: 0, // إيداع درج
    cash_withdrawals: 0, // سحب درج
    expenses: 0, // مصروفات
  };

  // كل العمليات في قايمة واحدة (in = داخل الدرج، out = خارج)
  const transactions = [];

  for (const p of payments) {
    const kind = paymentKind(p.receipt_number);
    const amount = Number(p.amount);
    const key =
      kind === "wallet_charge"
        ? "wallet_charges"
        : kind === "attendance_cash"
          ? "attendance_cash"
          : "payments";
    totals[key] += amount;
    transactions.push({
      id: `payment-${p.id}`,
      type: kind,
      direction: "in",
      amount,
      at: p.paid_at,
      title: p.student?.name ?? null,
      note: p.notes,
      receipt_number: p.receipt_number,
      branch: p.branch,
    });
  }

  for (const c of cash) {
    const amount = Number(c.amount);
    const isDeposit = c.type === "deposit";
    totals[isDeposit ? "cash_deposits" : "cash_withdrawals"] += amount;
    transactions.push({
      id: `cash-${c.id}`,
      type: isDeposit ? "cash_deposit" : "cash_withdrawal",
      direction: isDeposit ? "in" : "out",
      amount,
      at: c.created_at,
      title: c.reason,
      note: null,
      branch: c.branch,
    });
  }

  for (const e of expenses) {
    const amount = Number(e.amount);
    totals.expenses += amount;
    transactions.push({
      id: `expense-${e.id}`,
      type: "expense",
      direction: "out",
      amount,
      at: e.expense_date,
      title: e.category,
      note: e.description,
      branch: e.branch,
    });
  }

  transactions.sort((a, b) => new Date(a.at) - new Date(b.at));

  const totalIncome =
    totals.payments +
    totals.wallet_charges +
    totals.attendance_cash +
    totals.cash_deposits;
  const totalExpenses = totals.expenses + totals.cash_withdrawals;

  // الحضور — الخصم من المحفظة للعرض بس (مش بيدخل الدخل: اتحسب وقت الشحن)
  const countOf = (s) =>
    attendance.find((r) => r.status === s)?._count.status || 0;
  const attendanceSummary = {
    present: countOf("present"),
    late: countOf("late"),
    absent: countOf("absent"),
    total: attendance.reduce((sum, r) => sum + r._count.status, 0),
    wallet_debited: attendance.reduce(
      (sum, r) => sum + Number(r._sum.wallet_debited || 0),
      0,
    ),
  };

  return {
    totals: {
      ...totals,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net: totalIncome - totalExpenses,
    },
    attendance: attendanceSummary,
    transactions,
  };
};

// ── GET /api/reports/revenue ──────────────────────────────
// الرسم البياني: دخل + مصروف لكل يوم في الشهر (daily) أو لكل شهر في السنة (monthly)
//   كل الأيام/الشهور بترجع — حتى الفاضية (أصفار) عشان الرسم يبقى مظبوط
//   الحسبة نفس الملخص وتقفيل الجلسة: الدخل = مدفوعات + إيداع، المصروف = مصروفات + سحب
//   amount = الدخل (فاضل عشان التوافق مع أي مكان بيقرا الحقل القديم)
const getRevenue = async (req, res, next) => {
  try {
    const { period = "monthly", month, year, branch_id } = req.query;

    const now = new Date();
    const y = parseInt(year) || now.getFullYear();
    const m = parseInt(month) || now.getMonth() + 1;
    const isDaily = period === "daily";

    const from = isDaily ? new Date(y, m - 1, 1) : new Date(y, 0, 1);
    const to = isDaily ? new Date(y, m, 1) : new Date(y + 1, 0, 1);

    const branchId = branch_id ? parseInt(branch_id) : null;
    const { totals, transactions } = await collectFinancials(
      req,
      from,
      to,
      branchId,
    );

    const keyOf = (d) =>
      isDaily
        ? dayKey(d)
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    // جهّز كل الأيام/الشهور بأصفار
    const buckets = new Map();
    if (isDaily) {
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        buckets.set(dayKey(new Date(y, m - 1, d)), { income: 0, expenses: 0 });
      }
    } else {
      for (let i = 0; i < 12; i++) {
        buckets.set(`${y}-${String(i + 1).padStart(2, "0")}`, {
          income: 0,
          expenses: 0,
        });
      }
    }

    for (const t of transactions) {
      const b = buckets.get(keyOf(new Date(t.at)));
      if (!b) continue;
      if (t.direction === "in") b.income += t.amount;
      else b.expenses += t.amount;
    }

    const breakdown = [...buckets.entries()].map(([date, b]) => ({
      date,
      amount: b.income,
      income: b.income,
      expenses: b.expenses,
      net: b.income - b.expenses,
    }));

    res.json({
      success: true,
      data: {
        period,
        total: totals.total_income,
        total_expenses: totals.total_expenses,
        breakdown,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/profit ───────────────────────────────
const getProfit = async (req, res, next) => {
  try {
    const { month, year, branch_id } = req.query;
    const now = new Date();
    const y = parseInt(year) || now.getFullYear();
    const m = parseInt(month) || now.getMonth() + 1;

    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 1);

    const tw = tenantWhere(req);
    const branchFilter = branch_id ? { branch_id: parseInt(branch_id) } : {};

    const [payments, expenses, cashIn, cashOut] = await Promise.all([
      prisma.payment.aggregate({
        where: { ...tw, ...branchFilter, paid_at: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { ...tw, ...branchFilter, expense_date: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
      prisma.cashTransaction.aggregate({
        where: {
          ...tw,
          ...branchFilter,
          type: "deposit",
          created_at: { gte: from, lt: to },
        },
        _sum: { amount: true },
      }),
      prisma.cashTransaction.aggregate({
        where: {
          ...tw,
          ...branchFilter,
          type: "withdrawal",
          created_at: { gte: from, lt: to },
        },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome =
      Number(payments._sum.amount || 0) + Number(cashIn._sum.amount || 0);
    const totalExpenses =
      Number(expenses._sum.amount || 0) + Number(cashOut._sum.amount || 0);

    res.json({
      success: true,
      data: {
        month: m,
        year: y,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: totalIncome - totalExpenses,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/summary ──────────────────────────────
// تقرير يومي/شهري بكل العمليات المالية + الحضور
//   period=daily   &date=YYYY-MM-DD  (افتراضي: النهارده)
//   period=monthly &month=YYYY-MM    (افتراضي: الشهر الحالي)
//   branch_id اختياري
const getSummary = async (req, res, next) => {
  try {
    const { period = "daily", date, month, branch_id } = req.query;
    const now = new Date();
    let from, to;

    if (period === "monthly") {
      let y = now.getFullYear();
      let m = now.getMonth() + 1;
      if (month) {
        [y, m] = String(month).split("-").map(Number);
        if (!y || !m) {
          return res
            .status(400)
            .json({ success: false, message: "month must be YYYY-MM." });
        }
      }
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 1);
    } else {
      from = date
        ? parseDay(date)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (!from) {
        return res
          .status(400)
          .json({ success: false, message: "date must be YYYY-MM-DD." });
      }
      to = new Date(from);
      to.setDate(to.getDate() + 1);
    }

    const branchId = branch_id ? parseInt(branch_id) : null;
    const { totals, attendance, transactions } = await collectFinancials(
      req,
      from,
      to,
      branchId,
    );

    const data = { period, from, to, totals, attendance };

    if (period === "monthly") {
      // الشهري: إجمالي كل يوم
      const days = {};
      for (const t of transactions) {
        const key = dayKey(new Date(t.at));
        if (!days[key])
          days[key] = { date: key, income: 0, expenses: 0, net: 0 };
        if (t.direction === "in") days[key].income += t.amount;
        else days[key].expenses += t.amount;
        days[key].net = days[key].income - days[key].expenses;
      }
      data.days = Object.values(days).sort((a, b) =>
        a.date.localeCompare(b.date),
      );
    } else {
      // اليومي: كل عملية لوحدها
      data.transactions = transactions;
    }

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/attendance ───────────────────────────
const getAttendance = async (req, res, next) => {
  try {
    const { course_id, date, branch_id } = req.query;

    const where = { ...tenantWhere(req) };
    if (course_id) where.course_id = parseInt(course_id);
    if (branch_id) where.branch_id = parseInt(branch_id);
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
    const present =
      records.find((r) => r.status === "present")?._count.status || 0;
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
// الإيراد = مجموع (cash_paid + wallet_debited) من حضور الكورس
// الفلترة: period=current_month | last_30_days، أو month=YYYY-MM لشهر محدد
const getTopCourses = async (req, res, next) => {
  try {
    const { period, month, branch_id } = req.query;

    // ── حدّد الفترة الزمنية ──────────────────────────────
    const now = new Date();
    let from, to, label;

    if (month) {
      // شهر محدد بصيغة YYYY-MM (مثلاً 2026-07)
      const [y, m] = month.split("-").map(Number);
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 1);
      label = month;
    } else if (period === "last_30_days") {
      // آخر 30 يوم (متحرك)
      to = new Date(now);
      to.setHours(23, 59, 59, 999);
      from = new Date(now);
      from.setDate(from.getDate() - 30);
      from.setHours(0, 0, 0, 0);
      label = "last_30_days";
    } else {
      // افتراضي: الشهر الحالي
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }

    // ── فلترة الحضور ─────────────────────────────────────
    const where = {
      ...tenantWhere(req),
      date: { gte: from, lt: to },
    };
    if (branch_id) where.branch_id = parseInt(branch_id);

    // ── جيب كل سجلات الحضور في الفترة مع الكورس ──────────
    const records = await prisma.attendance.findMany({
      where,
      select: {
        course_id: true,
        cash_paid: true,
        wallet_debited: true,
        course: { select: { id: true, name: true } },
      },
    });

    // ── جمّع الإيراد لكل كورس ─────────────────────────────
    const map = {};
    for (const r of records) {
      if (!r.course) continue;
      const id = r.course.id;
      if (!map[id]) {
        map[id] = {
          id,
          name: r.course.name,
          revenue: 0,
          attendance_count: 0,
        };
      }
      const cash = Number(r.cash_paid || 0);
      const wallet = Number(r.wallet_debited || 0);
      map[id].revenue += cash + wallet;
      map[id].attendance_count += 1;
    }

    // ── رتّب تنازلياً حسب الإيراد ─────────────────────────
    const result = Object.values(map).sort((a, b) => b.revenue - a.revenue);

    res.json({
      success: true,
      data: result,
      meta: { period: label, from, to },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/renewals ─────────────────────────────
const getRenewals = async (req, res, next) => {
  try {
    const tw = tenantWhere(req);

    const total = await prisma.enrollment.count({ where: { ...tw } });
    const active = await prisma.enrollment.count({
      where: {
        ...tw,
        OR: [{ end_date: null }, { end_date: { gte: new Date() } }],
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

// ── GET /api/reports/today ────────────────────────────────
// الداشبورد: إيراد النهارده = إجمالي الدخل (نفس رقم تقفيل الجلسة)
//   today_revenue فاضل بنفس الاسم عشان الفلاتر مايتكسرش
const getTodayRevenue = async (req, res, next) => {
  try {
    const { branch_id } = req.query;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const branchId = branch_id ? parseInt(branch_id) : null;
    const { totals } = await collectFinancials(req, today, tomorrow, branchId);

    res.json({
      success: true,
      data: {
        today_revenue: totals.total_income,
        breakdown: totals,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/month ────────────────────────────────
const getMonthRevenue = async (req, res, next) => {
  try {
    const { branch_id } = req.query;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const branchId = branch_id ? parseInt(branch_id) : null;
    const { totals } = await collectFinancials(
      req,
      startOfMonth,
      startOfNextMonth,
      branchId,
    );

    res.json({
      success: true,
      data: {
        month_revenue: totals.total_income,
        breakdown: totals,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/reports/students ─────────────────────────────
const getStudentReport = async (req, res, next) => {
  try {
    const { student_id } = req.query;

    if (!student_id) {
      return res
        .status(400)
        .json({ success: false, message: "student_id is required." });
    }
    const sid = parseInt(student_id);

    // الطالب لازم من نفس السنتر (نتأكد الأول قبل أي تجميع)
    const student = await prisma.student.findUnique({
      where: { id: sid },
      include: { enrollments: { include: { course: true } } },
    });
    assertSameTenant(req, student);

    const [attendance, payments, grades] = await Promise.all([
      prisma.attendance.groupBy({
        by: ["status"],
        where: { student_id: sid },
        _count: { status: true },
      }),
      prisma.payment.aggregate({
        where: { student_id: sid },
        _sum: { amount: true },
      }),
      prisma.studentGrade.findMany({
        where: { student_id: sid },
        include: { exam: { select: { title: true, exam_date: true } } },
      }),
    ]);

    const totalAttendance = attendance.reduce(
      (sum, r) => sum + r._count.status,
      0,
    );
    const present =
      attendance.find((r) => r.status === "present")?._count.status || 0;

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
          absent:
            attendance.find((r) => r.status === "absent")?._count.status || 0,
          percentage:
            totalAttendance > 0
              ? `${((present / totalAttendance) * 100).toFixed(1)}%`
              : "0%",
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
  getSummary,
  getAttendance,
  getTopCourses,
  getRenewals,
  getStudentReport,
  getTodayRevenue,
  getMonthRevenue,
};
