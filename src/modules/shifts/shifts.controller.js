// src/modules/shifts/shifts.controller.js
const prisma = require("../../config/db");
const { tenantWhere, requireTenantId, assertSameTenant } =
  require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const {
  isConnected,
  endSession,
  closeUserStreams,
} = require("../../core/session");
const {
  round2,
  expectedBalance,
  loadDrawer,
  resolveExpected,
  sendExpectedChanged,
  recordCount,
  flagOthersForAck,
  lastCountOf,
} = require("../../core/drawerBalance");
const { SHIFT_INCLUDE, closeShiftWithTotals } = require("./shifts.service");

// مين يقدر يقفل شيفت حد تاني
const MANAGER_ROLES = ["admin", "owner", "super_admin"];

/// خطأ بكود تعرفه الشاشة — عشان تعرف تفتح الدايالوج الصح
const coded = (status, code, message, data = null) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.data = data;
  return err;
};

const sendCoded = (res, err) =>
  res.status(err.status).json({
    success: false,
    code: err.code,
    message: err.message,
    ...(err.data ? { data: err.data } : {}),
  });

/// كل الأخطاء اللي الشاشة بتتصرّف فيها بدل ما تعرض رسالة وخلاص
const handled = (res, err, next) => {
  if (err?.code === "EXPECTED_CHANGED") return sendExpectedChanged(res, err);
  if (err?.code && err?.status && typeof err.status === "number") {
    return sendCoded(res, err);
  }
  return next(err);
};

// Helper: الفرع لازم تابع لنفس السنتر
const assertBranchInTenant = async (branchId, tenantId) => {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, tenant_id: true },
  });
  if (!branch || branch.tenant_id !== tenantId) {
    const err = new Error("Branch not found in this center.");
    err.status = 400;
    throw err;
  }
};

/**
 * الفرع لازم يكون من فروع اليوزر.
 *
 * ⚠ الراوت بيعدّي بـ validateBranch اللي بيتأكد إن الفرع موجود
 *   وشغّال وتابع للسنتر — مش إن اليوزر ليه صلاحية عليه. يعني
 *   الريسبشن كان يقدر يفتح درج على أي فرع في السنتر.
 */
const assertBranchAllowed = (req, branchId) => {
  const allowed = getAllowedBranchIds(req.user); // null = كل الفروع
  if (allowed && !allowed.includes(branchId)) {
    const err = new Error("Forbidden. You don't have access to this branch.");
    err.status = 403;
    throw err;
  }
};

// ← لكل شيفت مفتوح: صاحبه فاتح البرنامج دلوقتي ولا لأ
const withConnection = (shift) => ({
  ...shift,
  user_connected: !shift.closed_at && isConnected(shift.user?.last_seen_at),
});

/**
 * الدرج اللي الوردية هتتفتح عليه.
 *   - drawer_id مبعوت → لازم يكون في نفس الفرع
 *   - مش مبعوت والفرع فيه درج واحد → هو
 *   - أكتر من درج → الشاشة لازم تخلّيه يختار
 */
const resolveDrawerForOpen = async (tenantId, branchId, drawerId) => {
  if (drawerId) {
    const drawer = await loadDrawer(prisma, { id: drawerId, tenantId });
    if (drawer.branch_id !== branchId) {
      throw coded(400, "DRAWER_WRONG_BRANCH", "الدرج ده مش في الفرع المختار.");
    }
    return drawer;
  }

  const actives = await prisma.cashDrawer.findMany({
    where: { tenant_id: tenantId, branch_id: branchId, is_active: true },
    orderBy: { id: "asc" },
  });

  if (actives.length === 0) {
    throw coded(
      400,
      "NO_DRAWER",
      "الفرع ده مالوش درج — لازم المدير يضيف درج الأول."
    );
  }
  if (actives.length === 1) return actives[0];

  throw coded(400, "DRAWER_REQUIRED", "اختار الدرج اللي هتشتغل عليه.", {
    drawers: actives,
  });
};

// ── POST /api/shifts/open ─────────────────────────────────
// body: { branch_id, drawer_id?, confirmed?, counted?, expected_seen?, force? }
//
//   الشاشة بتنده مرتين:
//     ١) من غير confirmed/counted → بترجع 400 CONFIRM_REQUIRED
//        ومعاها المتوقع وآخر جرد → الشاشة تعرض «الدرج فيه ٣٢٠٠، متأكد؟»
//     ٢) confirmed: true (استلم زي ما هو) أو counted: <الرقم اللي لقاه>
//
//   force = true → بيقفل درجه المفتوح القديم ويفتح جديد
const openShift = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const branchId = req.branchId; // من validateBranch (الفرع المختار)
    const {
      drawer_id,
      counted,
      expected_seen,
      confirmed,
      force = false,
    } = req.validated?.body || {};

    await assertBranchInTenant(branchId, tenantId);
    assertBranchAllowed(req, branchId);

    const drawer = await resolveDrawerForOpen(tenantId, branchId, drawer_id);

    // شيفت واحد مفتوح بس للموظف (في أي فرع)
    const existing = await prisma.shift.findFirst({
      where: { user_id: req.user.id, closed_at: null },
      orderBy: { opened_at: "desc" },
      include: SHIFT_INCLUDE,
    });

    if (existing && force !== true) {
      return res.status(409).json({
        success: false,
        code: "SHIFT_OPEN",
        message: "You already have an open shift.",
        data: existing, // الفلاتر بيعرضه في دايلوج "كمّل / ابدأ جديد"
      });
    }

    // لسه ماأكّدش الرصيد → رجّع له الرقم وآخر جرد ويرد
    if (counted === undefined && confirmed !== true) {
      const [expected, lastCount] = await Promise.all([
        expectedBalance(prisma, drawer),
        lastCountOf(prisma, drawer.id),
      ]);
      throw coded(
        400,
        "CONFIRM_REQUIRED",
        `الدرج "${drawer.name}" فيه ${expected} — أكّد الرقم أو اكتب اللي لقيته.`,
        { drawer, expected, last_count: lastCount }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // ⚠ الفحص فوق برّه الترانزاكشن — ضغطتين في نفس اللحظة كانوا
      //   بيعدّوا الاتنين ويفتحوا درجين لنفس الموظف، وساعتها
      //   getCurrent و resolveShiftId ممكن يمسكوا وردية مختلفة
      //   والفلوس تتوزّع على الاتنين.
      //   الحل النهائي index في الداتابيز:
      //     CREATE UNIQUE INDEX shifts_one_open_per_user
      //       ON shifts(user_id) WHERE closed_at IS NULL;
      const stillOpen = await tx.shift.findMany({
        where: { user_id: req.user.id, closed_at: null },
        orderBy: { opened_at: "desc" },
      });

      // القفل الإجباري هنا **من غير جرد** — الموظف مش واقف قدام
      // الدرج القديم عشان يعدّه. الحركات بتفضل محسوبة في رصيد
      // الدرج (last_counted_at ماتحركش)، فمفيش فلوس بتضيع —
      // أول جرد جاي هو اللي هيسوّي.
      let closedReport = null;
      for (const old of stillOpen) {
        const r = await closeShiftWithTotals(tx, old, req.user.id, null);
        closedReport ??= r;
      }

      const expected = await resolveExpected(tx, drawer, expected_seen);
      const opening = counted !== undefined ? round2(counted) : expected;

      const shift = await tx.shift.create({
        data: {
          tenant_id: tenantId,
          user_id: req.user.id,
          branch_id: branchId,
          drawer_id: drawer.id,
          opening_balance: opening,
        },
        include: SHIFT_INCLUDE,
      });

      const { count, variance } = await recordCount(tx, {
        drawer,
        tenantId,
        shiftId: shift.id,
        userId: req.user.id,
        reason: "open",
        expected,
        counted: opening,
      });

      // لقى رقم مختلف → اللي شغالين على نفس الدرج لازم يعرفوا
      if (variance !== 0) {
        await flagOthersForAck(tx, {
          drawerId: drawer.id,
          exceptShiftId: shift.id,
        });
      }

      return { shift, closedReport, expected, opening, variance, count };
    });

    res.status(201).json({
      success: true,
      message: "Shift opened successfully.",
      data: result.shift,
      closed_previous: result.closedReport, // null لو مكانش فيه شيفت قديم
      drawer: {
        id: drawer.id,
        name: drawer.name,
        expected: result.expected,
        opening_balance: result.opening,
        variance: result.variance,
      },
    });
  } catch (err) {
    handled(res, err, next);
  }
};

// ── POST /api/shifts/close ────────────────────────────────
// body: { shift_id?, counted?, expected_seen? }
//
// من غير shift_id → الموظف بيقفل شيفته (مفيش شيفت؟ 200 و data: null)
// shift_id → مدير بيقفل شيفت موظف:
//   - الأدمن في فروعه بس
//   - الموظف لازم يكون مش فاتح البرنامج (وإلا → خروج إجباري)
//   - الموظف بيطلع من السيستم، فلو رجع يلاقي شاشة الدخول
//
// أي وردية عليها درج لازم معاها `counted` — من غيره بيرجع
// 400 COUNT_REQUIRED ومعاه المتوقع عشان الشاشة تفتح دايالوج العدّ.
const closeShift = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    // ⚠ كان بيقرا من req.body الخام مش من المتحقَّق منه —
    //   "5abc" كانت بتعدّي كـ 5 من parseInt
    const { shift_id: targetShiftId, counted, expected_seen } =
      req.validated?.body || {};
    const isManager = MANAGER_ROLES.includes(req.user.role);

    if (targetShiftId && !isManager) {
      const err = new Error("Unauthorized to close this shift.");
      err.status = 403;
      throw err;
    }

    let target = null;
    if (targetShiftId) {
      const allowed = getAllowedBranchIds(req.user); // null = كل الفروع

      target = await prisma.shift.findFirst({
        where: {
          id: targetShiftId,
          // ⚠ كان req.user.tenant_id — بيبقى null للسوبر أدمن
          //   حتى وهو جوه سنتر، فمكانش يقدر يقفل أي وردية
          tenant_id: tenantId,
          closed_at: null,
          ...(allowed && { branch_id: { in: allowed } }),
        },
        include: { user: { select: { id: true, last_seen_at: true } } },
      });

      // مش موجود / مقفول / في فرع ملوش صلاحية عليه → نفس الرد
      if (!target) {
        const err = new Error("No open shift found.");
        err.status = 404;
        throw err;
      }

      if (
        target.user_id !== req.user.id &&
        isConnected(target.user?.last_seen_at)
      ) {
        return res.status(409).json({
          success: false,
          code: "USER_CONNECTED",
          message:
            "الموظف يستخدم البرنامج الآن. استخدم «خروج إجباري» لإغلاق جلسته.",
        });
      }
    }

    // الوردية اللي هتتقفل — بنجيبها قبل الترانزاكشن عشان نعرف
    // هل عليها درج ومحتاجين عدّ ولا لأ
    let shift = target;
    if (!shift) {
      shift = await prisma.shift.findFirst({
        where: { user_id: req.user.id, closed_at: null },
        orderBy: { opened_at: "desc" },
      });
      // مفيش شيفت؟ مش خطأ — بيحصل لما يعمل logout من غير شيفت
      if (!shift) {
        return res.json({
          success: true,
          message: "No open shift to close.",
          data: null,
        });
      }
    }

    let drawerCtx = null;
    if (shift.drawer_id) {
      const drawer = await loadDrawer(prisma, {
        id: shift.drawer_id,
        tenantId,
        allowInactive: true,
      });

      if (counted === undefined || counted === null) {
        const expected = await expectedBalance(prisma, drawer);
        throw coded(
          400,
          "COUNT_REQUIRED",
          `اكتب اللي في الدرج "${drawer.name}" قبل القفل.`,
          { drawer, expected, shift_id: shift.id }
        );
      }

      drawerCtx = { drawer, tenantId, counted, expectedSeen: expected_seen };
    }

    const closingOthers = shift.user_id !== req.user.id;

    const result = await prisma.$transaction(async (tx) => {
      const closed = await closeShiftWithTotals(
        tx,
        shift,
        req.user.id,
        drawerCtx
      );

      // ← الموظف لو النت رجعله أو فتح البرنامج، يلاقي شاشة الدخول
      //   بدل ما يكمّل شغل على شيفت مقفول
      if (closingOthers) await endSession(shift.user_id, tx);

      return closed;
    });

    if (closingOthers) closeUserStreams(shift.user_id);

    res.json({
      success: true,
      message: "Shift closed successfully.",
      data: result,
    });
  } catch (err) {
    handled(res, err, next);
  }
};

// ── POST /api/shifts/ack ──────────────────────────────────
// حد تاني قفل (أو المدير عدّ) على نفس الدرج — ده تأكيد الرصيد الجديد.
// body: { confirmed?, counted?, expected_seen? }
const ackDrawer = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const { counted, expected_seen, confirmed } = req.validated?.body || {};

    const shift = await prisma.shift.findFirst({
      where: { user_id: req.user.id, closed_at: null },
      orderBy: { opened_at: "desc" },
    });

    if (!shift || !shift.needs_ack || !shift.drawer_id) {
      return res.json({
        success: true,
        message: "Nothing to acknowledge.",
        data: { needs_ack: false },
      });
    }

    const drawer = await loadDrawer(prisma, {
      id: shift.drawer_id,
      tenantId,
      allowInactive: true,
    });

    const lastCount = await lastCountOf(prisma, drawer.id);

    if (counted === undefined && confirmed !== true) {
      const expected = await expectedBalance(prisma, drawer);
      throw coded(
        400,
        "CONFIRM_REQUIRED",
        `${lastCount?.user?.name || "حد تاني"} قفل على الدرج — الدرج فيه ${expected}. متأكد؟`,
        { drawer, expected, last_count: lastCount }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const expected = await resolveExpected(tx, drawer, expected_seen);
      const value = counted !== undefined ? round2(counted) : expected;

      const { count, variance } = await recordCount(tx, {
        drawer,
        tenantId,
        shiftId: shift.id,
        userId: req.user.id,
        reason: "handover",
        expected,
        counted: value,
        // الاسمين في نفس الصف: اللي قفل واللي استلم
        relatedUserId: lastCount?.user_id ?? null,
      });

      await tx.shift.update({
        where: { id: shift.id },
        data: { needs_ack: false },
      });

      // لقى رقم مختلف → أي حد تاني لسه شغال لازم يعرف
      if (variance !== 0) {
        await flagOthersForAck(tx, {
          drawerId: drawer.id,
          exceptShiftId: shift.id,
        });
      }

      return { expected, counted: value, variance, count };
    });

    res.json({
      success: true,
      message: "Drawer acknowledged.",
      data: { needs_ack: false, ...result },
    });
  } catch (err) {
    handled(res, err, next);
  }
};

// ── GET /api/shifts (كل الجلسات — مفلترة بالسنتر) ────────
// query:
//   all_branches=true → كل الفروع المسموحة (بيتجاهل الفرع اللي الـ interceptor بيحقنه)
//   status=open|closed → المفتوحة بس / المقفولة بس
// كل شيفت مفتوح معاه user_connected (صاحبه فاتح البرنامج دلوقتي)
const getAll = async (req, res, next) => {
  try {
    const { branch_id, all_branches, status, drawer_id } = req.validated.query;
    const page = req.validated.query.page || 1;
    const limit = req.validated.query.limit || 20;
    const skip = (page - 1) * limit;

    const where = { ...tenantWhere(req) };

    const branchFilter = all_branches === "true" ? undefined : branch_id;
    if (branchFilter) where.branch_id = branchFilter;
    if (drawer_id) where.drawer_id = drawer_id;

    if (status === "open") where.closed_at = null;
    if (status === "closed") where.closed_at = { not: null };

    if (req.user.role === "receptionist") {
      // الريسبشن يشوف شيفتاته هو بس
      where.user_id = req.user.id;
    } else {
      // الأدمن ميشوفش شيفتات فرع ملوش صلاحية عليه
      const allowed = getAllowedBranchIds(req.user);
      if (allowed) {
        if (branchFilter && !allowed.includes(branchFilter)) {
          return res.json({
            success: true,
            data: [],
            pagination: { total: 0, page, limit, pages: 0 },
          });
        }
        if (!branchFilter) where.branch_id = { in: allowed };
      }
    }

    const [shifts, total] = await Promise.all([
      prisma.shift.findMany({
        where,
        skip,
        take: limit,
        orderBy: { opened_at: "desc" },
        include: SHIFT_INCLUDE,
      }),
      prisma.shift.count({ where }),
    ]);

    res.json({
      success: true,
      data: shifts.map(withConnection),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/shifts/summary ───────────────────────────────
// ملخص جلسات (كروت الشهر/السنة في شاشة الجلسات) — طلب واحد
//   ?month=2026-09  → كل الجلسات المقفولة اللي اتفتحت في الشهر ده
//   ?year=2026      → كل الجلسات المقفولة في السنة
//   ?ids=1,2,3      → جلسات محددة
// الشهر/السنة بيتحسبوا من السيرفر (مش من الجلسات اللي الشاشة حمّلتها)
//   → الأرقام صح حتى لو الشاشة لسه ماحمّلتش كل الجلسات
// الفلترة نفس getAll: الفرع المختار (أو all_branches)، الريسبشن جلساته بس، الأدمن فروعه بس
// الحسبة نفس تقفيل الجلسة: الصافي = (مدفوعات + إيداع) − (مصروفات + سحب)، الحضور = حاضر + متأخر
const getSummary = async (req, res, next) => {
  try {
    const q = req.validated?.query ?? req.query;

    const empty = {
      shifts_count: 0,
      total_payments: 0,
      total_deposits: 0,
      total_expenses: 0,
      total_withdrawals: 0,
      net: 0,
      attendance_count: 0,
      students_added: 0,
      total_variance: 0,
      shortages_count: 0,
    };

    const where = { ...tenantWhere(req) };

    if (q.month || q.year) {
      // ── بالشهر / السنة ──────────────────────────────
      let from, to;
      if (q.month) {
        const [y, m] = String(q.month).split("-").map(Number);
        from = new Date(y, m - 1, 1);
        to = new Date(y, m, 1);
      } else {
        const y = Number(q.year);
        from = new Date(y, 0, 1);
        to = new Date(y + 1, 0, 1);
      }
      where.opened_at = { gte: from, lt: to };
      where.closed_at = { not: null }; // زي الشاشة: الكروت للمقفولة بس

      const branchFilter = q.all_branches === "true" ? undefined : q.branch_id;
      if (branchFilter) where.branch_id = Number(branchFilter);
    } else {
      // ── جلسات محددة ────────────────────────────────
      const requested = String(q.ids || "")
        .split(",")
        .map((x) => parseInt(x, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 1000);
      if (requested.length === 0) return res.json({ success: true, data: empty });
      where.id = { in: requested };
    }

    // ← الصلاحيات
    if (req.user.role === "receptionist") {
      where.user_id = req.user.id;
    } else {
      const allowed = getAllowedBranchIds(req.user);
      if (allowed) {
        if (typeof where.branch_id === "number" && !allowed.includes(where.branch_id)) {
          return res.json({ success: true, data: empty });
        }
        if (where.branch_id === undefined) where.branch_id = { in: allowed };
      }
    }

    const visible = await prisma.shift.findMany({
      where,
      select: { id: true, variance: true },
    });
    const ids = visible.map((s) => s.id);
    if (ids.length === 0) return res.json({ success: true, data: empty });

    const byShift = { shift_id: { in: ids } };

    const [payments, expenses, cash, attendance, students] = await Promise.all([
      prisma.payment.aggregate({ where: byShift, _sum: { amount: true } }),
      prisma.expense.aggregate({ where: byShift, _sum: { amount: true } }),
      prisma.cashTransaction.groupBy({
        by: ["type"],
        where: byShift,
        _sum: { amount: true },
      }),
      prisma.attendance.count({
        where: { ...byShift, status: { in: ["present", "late"] } },
      }),
      prisma.student.count({ where: byShift }),
    ]);

    const cashOf = (type) =>
      Number(cash.find((c) => c.type === type)?._sum.amount || 0);

    const totalPayments = Number(payments._sum.amount || 0);
    const totalExpenses = Number(expenses._sum.amount || 0);
    const totalDeposits = cashOf("deposit");
    const totalWithdrawals = cashOf("withdrawal");

    // ← جديد: إجمالي العجز/الزيادة وعدد الورديات اللي طلعت بفرق
    const withVariance = visible.filter((s) => s.variance !== null);
    const totalVariance = round2(
      withVariance.reduce((acc, s) => acc + Number(s.variance), 0)
    );

    res.json({
      success: true,
      data: {
        shifts_count: ids.length,
        total_payments: totalPayments,
        total_deposits: totalDeposits,
        total_expenses: totalExpenses,
        total_withdrawals: totalWithdrawals,
        net: totalPayments + totalDeposits - totalExpenses - totalWithdrawals,
        attendance_count: attendance,
        students_added: students,
        total_variance: totalVariance,
        shortages_count: withVariance.filter((s) => Number(s.variance) !== 0)
          .length,
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
      take: 50,
      include: {
        branch: { select: { id: true, name: true } },
        drawer: { select: { id: true, name: true } },
        closer: { select: { id: true, name: true, role: true } },
      },
    });

    res.json({ success: true, data: shifts });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/shifts/current (الجلسة المفتوحة) ────────────
// مفيش شيفت = حالة طبيعية → 200 و data: null
// لو needs_ack → معاها pending_ack: الرصيد المتوقع وآخر جرد،
// وده اللي الشاشة بتبني منه دايالوج «أحمد قفل والدرج فيه كذا».
const getCurrent = async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({
      where: { user_id: req.user.id, closed_at: null },
      // ⚠ كان من غير ترتيب. لو حصل درجين مفتوحين (سباق في /open)،
      //   ده كان ممكن يرجّع وردية و resolveShiftId يرجّع التانية —
      //   فالشاشة تعرض وردية والفلوس تدخل التانية.
      orderBy: { opened_at: "desc" },
      include: {
        user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        drawer: true,
      },
    });

    if (!shift) return res.json({ success: true, data: null });

    let pendingAck = null;
    if (shift.needs_ack && shift.drawer) {
      const [expected, lastCount] = await Promise.all([
        expectedBalance(prisma, shift.drawer),
        lastCountOf(prisma, shift.drawer.id),
      ]);
      pendingAck = { expected, last_count: lastCount };
    }

    res.json({ success: true, data: { ...shift, pending_ack: pendingAck } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/shifts/:id/report ────────────────────────────
const getReport = async (req, res, next) => {
  try {
    const shiftId = req.validated.params.id;

    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
      include: {
        user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        drawer: { select: { id: true, name: true } },
        closer: { select: { id: true, name: true, role: true } },
        payments: { include: { student: { select: { id: true, name: true } } } },
        expenses: true,
        cash_transactions: true,
        attendance: {
          include: { student: { select: { id: true, name: true } } },
        },
        // ← جديد: جرد الدرج اللي حصل في الوردية دي
        drawer_counts: {
          orderBy: { counted_at: "asc" },
          include: {
            user: { select: { id: true, name: true } },
            related_user: { select: { id: true, name: true } },
          },
        },
      },
    });

    // بيرمي 404 لو مش موجود أو من سنتر تاني
    assertSameTenant(req, shift);

    // الريسبشن يشوف شيفته بس
    if (req.user.role === "receptionist" && shift.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "You can only view your own shifts.",
      });
    }

    // الأدمن ميشوفش شيفت فرع ملوش صلاحية عليه (كأنه مش موجود)
    if (req.user.role !== "receptionist") {
      const allowed = getAllowedBranchIds(req.user);
      if (allowed && !allowed.includes(shift.branch_id)) {
        return res.status(404).json({
          success: false,
          message: "Shift not found.",
        });
      }
    }

    const studentsAdded = await prisma.student.count({
      where: { shift_id: shiftId },
    });

    res.json({ success: true, data: { ...shift, studentsAdded } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  openShift,
  closeShift,
  ackDrawer,
  getAll,
  getSummary,
  getMine,
  getCurrent,
  getReport,
};