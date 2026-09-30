// src/modules/dashboard/dashboard.controller.js
// كل أرقام الداشبورد في طلب واحد بدل 5 طلبات
const prisma = require("../../config/db");
const { requireTenantId } = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const { resolveBranchId } = require("../../middlewares/rbac");
const { isConnected } = require("../../core/session");
const { expectedBalance } = require("../../core/drawerBalance");

// ── Helpers ───────────────────────────────────────────────
const dayStart = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const num = (v) => Number(v || 0);

/// الفرع المختار — لازم يكون من فروع اليوزر وموجود وشغّال في السنتر.
/// من غير فرع → كل فروعه المسموحة (أو السنتر كله للأونر).
///
/// بيرجّع كمان `branchIds`: نطاق الفروع النهائي (null = كل الفروع)
/// عشان أي حسبة مش بتستخدم `where` تتقيّد بيه برضه.
const resolveScope = async (req, tenantId) => {
  const branchId = resolveBranchId(req);
  const allowed = getAllowedBranchIds(req.user); // null = كل الفروع
  const base = { tenant_id: tenantId };

  // مفيش فرع محدد
  if (branchId === null) {
    if (allowed) {
      return {
        branchId: null,
        branchIds: allowed,
        where: { ...base, branch_id: { in: allowed } },
      };
    }
    return { branchId: null, branchIds: null, where: base };
  }

  // 1) من فروعه؟ (فحص رخيص — من غير داتابيز)
  if (allowed && !allowed.includes(branchId)) {
    const err = new Error("Forbidden. You don't have access to this branch.");
    err.status = 403;
    throw err;
  }

  // 2) موجود وشغّال في السنتر؟
  //    من غير ده، فرع غلط بيرجّع أصفار وكأن مفيش داتا — والمستخدم بيتلخبط
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, tenant_id: tenantId, is_active: true },
    select: { id: true },
  });
  if (!branch) {
    const err = new Error("Branch not found or inactive.");
    err.status = 404;
    throw err;
  }

  return {
    branchId,
    branchIds: [branchId],
    where: { ...base, branch_id: branchId },
  };
};

/// نفس حسبة تقفيل الجلسة:
///   الدخل   = المدفوعات + إيداع الدرج
///   المصروف = المصروفات + سحب الدرج
async function moneyIn(where, from, to) {
  const range = { gte: from, lt: to };
  const [pay, exp, dep, wd] = await Promise.all([
    prisma.payment.aggregate({
      where: { ...where, paid_at: range },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { ...where, expense_date: range },
      _sum: { amount: true },
    }),
    prisma.cashTransaction.aggregate({
      where: { ...where, type: "deposit", created_at: range },
      _sum: { amount: true },
    }),
    prisma.cashTransaction.aggregate({
      where: { ...where, type: "withdrawal", created_at: range },
      _sum: { amount: true },
    }),
  ]);

  const payments = num(pay._sum.amount);
  const deposits = num(dep._sum.amount);
  const expenses = num(exp._sum.amount);
  const withdrawals = num(wd._sum.amount);
  const income = payments + deposits;
  const expense = expenses + withdrawals;

  return {
    income,
    expense,
    // (مدفوعات + إيداع) − (مصروفات + سحب) — حركة **النهاردة** بس.
    // ⚠ مش رصيد الدرج: الدرج شايل رصيد مرحّل، وممكن يكون في الفرع
    //   أكتر من درج. الرصيد الحقيقي في `drawers` تحت.
    net: income - expense,
    payments,
    deposits,
    expenses,
    withdrawals,
  };
}

/// اللي فعلاً في دروج الفرع دلوقتي.
///
/// ⚠ ده مش `today.net`. الـ net بيقيس حركة **النهاردة** في الفرع
///   كله؛ والدرج شايل رصيد من قبل كده، وممكن يكون في الفرع أكتر
///   من درج. الرقم الوحيد اللي يتقال عنه «اللي في الدرج» هو
///   آخر جرد + الحركات اللي بعده — وده اللي `expectedBalance`
///   بيحسبه.
async function drawersOf(tenantId, branchIds) {
  const rows = await prisma.cashDrawer.findMany({
    where: {
      tenant_id: tenantId,
      is_active: true,
      // null = كل فروع السنتر (أونر من غير فرع مختار).
      // `{ in: null }` بترمي من Prisma، فبنشيل الشرط أصلاً.
      ...(branchIds ? { branch_id: { in: branchIds } } : {}),
    },
    orderBy: [{ branch_id: "asc" }, { id: "asc" }],
    include: { branch: { select: { id: true, name: true } } },
  });

  const items = await Promise.all(
    rows.map(async (d) => ({
      id: d.id,
      name: d.name,
      branch_id: d.branch_id,
      branch_name: d.branch?.name ?? null,
      expected: await expectedBalance(prisma, d),
    })),
  );

  return { total: items.reduce((s, d) => s + d.expected, 0), items };
}

/// عدد الحضور بالحالة في فترة
///
/// ⚠ `absent` هيرجع صفر دايماً — الصف في جدول attendance بيتكتب
///   لما الطالب يحضر بس، الغياب مش بيتسجّل. شوف `deriveAbsent`.
async function attendanceIn(where, from, to) {
  const rows = await prisma.attendance.groupBy({
    by: ["status"],
    where: { ...where, attendance_day: { gte: from, lt: to } },
    _count: { _all: true },
  });
  const out = { present: 0, absent: 0, late: 0 };
  // أي حالة جديدة في الـ enum مش بتكسر الحسبة
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(out, r.status)) {
      out[r.status] = r._count._all;
    }
  }
  out.total = out.present + out.absent + out.late;
  return out;
}

// ── حصص النهاردة ──────────────────────────────────────────
// ميعاد من غير فرع = كل فروع المادة، فبنفلتر بالمادة المتاحة في الفرع
const SESSION_MINUTES = 120; // مدة افتراضية للحصة (مفيش end_time في المواعيد)

/**
 * @param branchIds نطاق الفروع — null = كل فروع السنتر
 *
 * ⚠ كانت بتاخد branchId المختار بس. لما الموظف يفتح الداشبورد من
 *   غير ما يبعت branch_id (وده اللي بيحصل أول ما البرنامج يفتح)،
 *   كان branchId = null فالدالة كانت بتفلتر بالـ tenant لوحده —
 *   يعني بيشوف حصص كل فروع السنتر وحضورها.
 */
async function todayClasses(tenantId, branchIds, today, tomorrow) {
  const dayOfWeek = new Date().getDay(); // 0=الأحد ... 6=السبت

  const branchFilter = branchIds
    ? {
        OR: [
          { branch_id: { in: branchIds } },
          {
            branch_id: null,
            course: { branches: { some: { branch_id: { in: branchIds } } } },
          },
        ],
      }
    : {};

  const schedules = await prisma.courseSchedule.findMany({
    where: {
      tenant_id: tenantId,
      day_of_week: dayOfWeek,
      ...branchFilter,
    },
    include: {
      course: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
  });

  if (schedules.length === 0) return [];

  const courseIds = [...new Set(schedules.map((s) => s.course_id))];

  const [enrollRows, attRows] = await Promise.all([
    // ⚠ كان بيعدّ كل تسجيلات المادة في السنتر كله — يعني `enrolled`
    //   كان بيجيب طلبة الفروع التانية، و `deriveAbsent` (المسجّلين −
    //   الحاضرين) كانت بتحسبهم غياب في الفرع ده. كمان كان بيعدّ
    //   التسجيلات اللي من غير طالب والطلبة الموقوفين.
    prisma.enrollment.groupBy({
      by: ["course_id"],
      where: {
        tenant_id: tenantId,
        course_id: { in: courseIds },
        student_id: { not: null },
        student: {
          is_active: true,
          ...(branchIds ? { branch_id: { in: branchIds } } : {}),
        },
      },
      _count: { _all: true },
    }),
    // ⚠ كان بيجمّع بالمادة بس. مادة ليها حصتين النهاردة كانت
    //   بتعرض نفس الرقم في الصفين — حضور حصة الساعة ٩:٤٨ كان
    //   بيظهر كمان على حصة ٩:٥٠ وكأنه اتسجّل مرتين. و `deriveAbsent`
    //   كانت بتجمع الغياب مرتين كمان، فالنسبة كلها كانت غلط.
    prisma.attendance.groupBy({
      by: ["course_id", "session_no", "status"],
      where: {
        tenant_id: tenantId,
        course_id: { in: courseIds },
        attendance_day: { gte: today, lt: tomorrow },
        ...(branchIds ? { branch_id: { in: branchIds } } : {}),
      },
      _count: { _all: true },
    }),
  ]);

  const enrolledBy = {};
  for (const e of enrollRows) enrolledBy[e.course_id] = e._count._all;

  const attBy = {};
  for (const r of attRows) {
    const key = `${r.course_id}#${r.session_no}`;
    attBy[key] ??= { present: 0, late: 0, absent: 0 };
    if (Object.prototype.hasOwnProperty.call(attBy[key], r.status)) {
      attBy[key][r.status] = r._count._all;
    }
  }

  // ── ترقيم الحصص ─────────────────────────────────────────
  // لازم يطابق `resolveSession` في كنترولر الحضور بالظبط:
  // مواعيد المادة النهاردة مرتّبة بالساعة، والمواعيد المتكررة
  // بنفس الساعة بتتعد حصة واحدة.
  const parseTime = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  const sessionNoOf = new Map(); // schedule.id → session_no
  const byCourse = {};
  for (const s of schedules) {
    (byCourse[s.course_id] ??= []).push(s);
  }
  for (const rows of Object.values(byCourse)) {
    const ordered = [...rows].sort(
      (a, b) => (parseTime(a.start_time) ?? 0) - (parseTime(b.start_time) ?? 0),
    );
    let no = 0;
    let prev = null;
    for (const s of ordered) {
      const t = parseTime(s.start_time);
      if (t !== prev) {
        no += 1;
        prev = t;
      }
      sessionNoOf.set(s.id, no);
    }
  }

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return (
    schedules
      .map((s) => {
        const startMinutes = parseTime(s.start_time) ?? 0;
        const sessionNo = sessionNoOf.get(s.id) ?? 1;
        const att = attBy[`${s.course_id}#${sessionNo}`] ?? {
          present: 0,
          late: 0,
          absent: 0,
        };

        let status = "upcoming";
        if (nowMinutes >= startMinutes + SESSION_MINUTES) status = "ended";
        else if (nowMinutes >= startMinutes) status = "ongoing";

        return {
          schedule_id: s.id,
          course_id: s.course_id,
          course_name: s.course.name,
          session_no: sessionNo,
          branch_id: s.branch_id,
          branch_name: s.branch?.name ?? null,
          start_time: s.start_time,
          status,
          enrolled: enrolledBy[s.course_id] ?? 0,
          attended: att.present + att.late,
          present: att.present,
          late: att.late,
        };
      })
      // ← start_time ممكن يكون null، و null.localeCompare بيرمي TypeError
      .sort((a, b) =>
        String(a.start_time ?? "").localeCompare(String(b.start_time ?? "")),
      )
  );
}

/// الغياب مشتق، مش مخزّن.
///
/// غياب الحصة = المسجّلين − (حاضر + متأخر)
///
/// وبس للحصص اللي **خلصت** — الطالب مايتحسبش غايب في حصة لسه
/// ماابتدتش أو شغالة دلوقتي، وإلا النسبة تبقى غلط الصبح وتتظبط بالليل.
function deriveAbsent(classes) {
  let absent = 0;
  for (const c of classes) {
    if (c.status !== "ended") continue;
    absent += Math.max(0, c.enrolled - c.attended);
  }
  return absent;
}

// ── GET /api/dashboard ────────────────────────────────────
const getDashboard = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const { branchIds, where } = await resolveScope(req, tenantId);

    const today = dayStart();
    const tomorrow = addDays(today, 1);
    const yesterday = addDays(today, -1);

    const isManager = ["super_admin", "owner", "admin"].includes(req.user.role);

    const [
      money,
      moneyYesterday,
      attToday,
      attYesterday,
      totalStudents,
      newToday,
      lowWallet,
      classes,
      recentStudents,
      openShifts,
    ] = await Promise.all([
      moneyIn(where, today, tomorrow),
      moneyIn(where, yesterday, today),
      attendanceIn(where, today, tomorrow),
      attendanceIn(where, yesterday, today),

      prisma.student.count({ where: { ...where, is_active: true } }),

      prisma.student.count({
        where: { ...where, created_at: { gte: today, lt: tomorrow } },
      }),

      // محفظته مفعّلة ورصيده خلص → هيتلخبط عند الباب
      prisma.student.count({
        where: {
          ...where,
          is_active: true,
          wallet_enabled: true,
          wallet_balance: { lte: 0 },
        },
      }),

      todayClasses(tenantId, branchIds, today, tomorrow),

      prisma.student.findMany({
        where: { ...where, is_active: true },
        orderBy: { created_at: "desc" },
        take: 5,
        select: {
          id: true,
          name: true,
          created_at: true,
          enrollments: {
            take: 1,
            orderBy: { created_at: "desc" }, // ← كان من غير ترتيب: مادة عشوائية
            select: { course: { select: { name: true } } },
          },
        },
      }),

      // مين شغال دلوقتي — للمديرين بس
      isManager
        ? prisma.shift.findMany({
            where: { ...where, closed_at: null },
            orderBy: { opened_at: "asc" },
            select: {
              id: true,
              opened_at: true,
              user: { select: { id: true, name: true, last_seen_at: true } },
              branch: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    // إجماليات كل جلسة مفتوحة — 4 طلبات مهما كان عددها
    let shifts = [];
    if (openShifts.length > 0) {
      const ids = openShifts.map((s) => s.id);
      const [pays, deps, exps, wds] = await Promise.all([
        prisma.payment.groupBy({
          by: ["shift_id"],
          where: { shift_id: { in: ids } },
          _sum: { amount: true },
        }),
        prisma.cashTransaction.groupBy({
          by: ["shift_id"],
          where: { shift_id: { in: ids }, type: "deposit" },
          _sum: { amount: true },
        }),
        prisma.expense.groupBy({
          by: ["shift_id"],
          where: { shift_id: { in: ids } },
          _sum: { amount: true },
        }),
        prisma.cashTransaction.groupBy({
          by: ["shift_id"],
          where: { shift_id: { in: ids }, type: "withdrawal" },
          _sum: { amount: true },
        }),
      ]);
      const sum = (rows, id) =>
        num(rows.find((r) => r.shift_id === id)?._sum.amount);

      shifts = openShifts.map((s) => ({
        id: s.id,
        user_id: s.user.id,
        user_name: s.user.name,
        branch_name: s.branch?.name ?? null,
        opened_at: s.opened_at,
        is_connected: isConnected(s.user.last_seen_at),
        net:
          sum(pays, s.id) + sum(deps, s.id) - sum(exps, s.id) - sum(wds, s.id),
      }));
    }

    // ⚠ بره الـ Promise.all عن قصد: الترتيب هناك هو اللي بيربط
    //   الاسم بالنتيجة، وأي إضافة في النص بتزحزح كل اللي بعدها.
    const drawers = await drawersOf(tenantId, branchIds);

    // الحاضر والمتأخر من الجدول (بيشمل الحضور اليدوي لأي مادة)،
    // والغايب مشتق من الحصص اللي خلصت.
    const absentToday = deriveAbsent(classes);
    const attendance = {
      present: attToday.present,
      late: attToday.late,
      absent: absentToday,
      total: attToday.present + attToday.late + absentToday,
    };

    res.json({
      success: true,
      data: {
        today: {
          ...money,
          attendance,
          new_students: newToday,
        },
        yesterday: {
          income: moneyYesterday.income,
          net: moneyYesterday.net,
          attendance_present: attYesterday.present + attYesterday.late,
        },
        total_students: totalStudents,
        low_wallet_count: lowWallet,
        // اللي فعلاً في الدروج دلوقتي — مش `today.net`
        drawers,
        classes,
        open_shifts: shifts,
        recent_students: recentStudents.map((s) => ({
          id: s.id,
          name: s.name,
          created_at: s.created_at,
          course_name: s.enrollments[0]?.course?.name ?? null,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getDashboard };
