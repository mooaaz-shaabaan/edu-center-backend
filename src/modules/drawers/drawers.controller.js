// src/modules/drawers/drawers.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const {
  round2,
  expectedBalance,
  drawerLedger,
  loadDrawer,
  recordCount,
  flagOthersForAck,
  expectedMatches,
} = require("../../core/drawerBalance");

const allowedBranches = (req) => getAllowedBranchIds(req.user);

const assertBranchAllowed = (req, branchId) => {
  const allowed = allowedBranches(req);
  if (allowed && !allowed.includes(branchId)) {
    const err = new Error("You don't have access to this branch.");
    err.status = 403;
    throw err;
  }
};

/** الفرع موجود في السنتر وشغّال */
const assertBranchUsable = async (req, branchId, tenantId) => {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, tenant_id: tenantId },
    select: { id: true, name: true, is_active: true },
  });
  if (!branch) {
    const err = new Error("الفرع مش موجود في السنتر ده.");
    err.status = 404;
    throw err;
  }
  if (!branch.is_active) {
    const err = new Error(`الفرع "${branch.name}" موقوف.`);
    err.status = 400;
    throw err;
  }
  assertBranchAllowed(req, branchId);
  return branch;
};

const COUNT_USER = { select: { id: true, name: true } };

/** آخر جرد على الدرج — ده اللي الدايالوج بيقول منه "أحمد قفل بـ ٣٢٠٠" */
const lastCountOf = (drawerId) =>
  prisma.drawerCount.findFirst({
    where: { drawer_id: drawerId },
    orderBy: { counted_at: "desc" },
    include: { user: COUNT_USER, related_user: COUNT_USER },
  });

const openShiftsOf = (drawerId) =>
  prisma.shift.findMany({
    where: { drawer_id: drawerId, closed_at: null },
    orderBy: { opened_at: "asc" },
    select: {
      id: true,
      opened_at: true,
      needs_ack: true,
      user: COUNT_USER,
    },
  });

// ═══════════════════════════════════════════
// GET /api/drawers?branch_id=&is_active=
// ═══════════════════════════════════════════
const getDrawers = async (req, res, next) => {
  try {
    const { branch_id, is_active } = req.validated.query;
    const allowed = allowedBranches(req);

    const where = { ...tenantWhere(req) };
    if (is_active !== undefined) where.is_active = is_active;

    if (branch_id) {
      assertBranchAllowed(req, branch_id);
      where.branch_id = branch_id;
    } else if (allowed !== null) {
      where.branch_id = { in: allowed };
    }

    const drawers = await prisma.cashDrawer.findMany({
      where,
      orderBy: [{ branch_id: "asc" }, { is_active: "desc" }, { id: "asc" }],
      include: { branch: { select: { id: true, name: true } } },
    });

    // عدد الدروج في الفرع صغير (١–٣ عادةً)، فـ N أضعاف الاستعلام مقبولة
    const data = await Promise.all(
      drawers.map(async (d) => ({
        ...d,
        expected: await expectedBalance(prisma, d),
        open_shifts: await openShiftsOf(d.id),
      })),
    );

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// GET /api/drawers/:id/state
// اللي الدايالوج بيتبني عليه: المتوقع + آخر جرد + مين شغال
// ═══════════════════════════════════════════
const getDrawerState = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const id = req.validated.params.id;

    const drawer = await loadDrawer(prisma, {
      id,
      tenantId,
      allowInactive: true,
    });
    assertBranchAllowed(req, drawer.branch_id);

    const [expected, lastCount, openShifts] = await Promise.all([
      expectedBalance(prisma, drawer),
      lastCountOf(drawer.id),
      openShiftsOf(drawer.id),
    ]);

    res.json({
      success: true,
      data: {
        drawer,
        expected,
        last_count: lastCount,
        open_shifts: openShifts,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// GET /api/drawers/:id/counts — سجل الجرد
// ═══════════════════════════════════════════
const getDrawerCounts = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const id = req.validated.params.id;
    const limit = req.validated.query?.limit || 50;

    const drawer = await loadDrawer(prisma, {
      id,
      tenantId,
      allowInactive: true,
    });
    assertBranchAllowed(req, drawer.branch_id);

    const counts = await prisma.drawerCount.findMany({
      where: { drawer_id: drawer.id },
      orderBy: { counted_at: "desc" },
      take: limit,
      include: { user: COUNT_USER, related_user: COUNT_USER },
    });

    res.json({ success: true, data: counts });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// GET /api/drawers/:id/ledger — كشف حركة الدرج
//
// كل حاجة دخلت أو خرجت من الصندوق في قايمة واحدة مرتّبة بالوقت:
// دفعات · شحن محفظة · كاش حضور · مصروفات · إيداع · سحب.
// كل صف شايل **مين عملها** والرصيد بعدها.
//
// ?since=all → من أول الدرج بدل من آخر جرد
// ═══════════════════════════════════════════
const getDrawerLedger = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const id = req.validated.params.id;
    const { limit, since } = req.validated.query || {};

    const drawer = await loadDrawer(prisma, {
      id,
      tenantId,
      allowInactive: true,
    });
    assertBranchAllowed(req, drawer.branch_id);

    const [rows, expected] = await Promise.all([
      drawerLedger(prisma, drawer, {
        limit: limit || 100,
        // من غيره بيبدأ من آخر جرد — وده اللي بيفسّر الرصيد الحالي
        since: since === "all" ? new Date(0) : null,
      }),
      expectedBalance(prisma, drawer),
    ]);

    res.json({
      success: true,
      data: {
        drawer,
        expected,
        since: since === "all" ? null : drawer.last_counted_at,
        opening: Number(drawer.last_counted_balance),
        movements: rows,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// POST /api/drawers
// ═══════════════════════════════════════════
const createDrawer = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const { name, branch_id } = req.validated.body;

    await assertBranchUsable(req, branch_id, tenantId);

    const duplicate = await prisma.cashDrawer.findFirst({
      where: { branch_id, name: name.trim() },
      select: { id: true },
    });
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: `فيه درج بنفس الاسم "${name.trim()}" في الفرع ده.`,
      });
    }

    const drawer = await prisma.cashDrawer.create({
      data: {
        tenant_id: tenantId,
        branch_id,
        name: name.trim(),
        // درج جديد بيبدأ فاضي — أول جرد هو اللي هيحط رصيده
        last_counted_balance: 0,
        last_counted_at: new Date(),
      },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.status(201).json({
      success: true,
      message: "Drawer created.",
      data: { ...drawer, expected: 0, open_shifts: [] },
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// PUT /api/drawers/:id
// ═══════════════════════════════════════════
const updateDrawer = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const id = req.validated.params.id;
    const { name, is_active } = req.validated.body;

    const drawer = await loadDrawer(prisma, {
      id,
      tenantId,
      allowInactive: true,
    });
    assertBranchAllowed(req, drawer.branch_id);

    if (name !== undefined) {
      const duplicate = await prisma.cashDrawer.findFirst({
        where: {
          branch_id: drawer.branch_id,
          name: name.trim(),
          id: { not: id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: `فيه درج بنفس الاسم "${name.trim()}" في الفرع ده.`,
        });
      }
    }

    if (is_active === false && drawer.is_active === true) {
      // درج فيه حد شغال مايتوقفش — فلوسه هتعلّق
      const stillOpen = await prisma.shift.count({
        where: { drawer_id: id, closed_at: null },
      });
      if (stillOpen > 0) {
        return res.status(400).json({
          success: false,
          message: "مينفعش توقف الدرج وفيه ورديات مفتوحة عليه.",
        });
      }

      const activeLeft = await prisma.cashDrawer.count({
        where: { branch_id: drawer.branch_id, is_active: true },
      });
      if (activeLeft <= 1) {
        return res.status(400).json({
          success: false,
          message: "مينفعش توقف آخر درج شغّال في الفرع.",
        });
      }
    }

    const updated = await prisma.cashDrawer.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(is_active !== undefined && { is_active }),
      },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.json({ success: true, message: "Drawer updated.", data: updated });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// DELETE /api/drawers/:id
// بيتحذف بس لو عمره ما اتستخدم — غير كده يتوقف
// ═══════════════════════════════════════════
const deleteDrawer = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const id = req.validated.params.id;

    const drawer = await loadDrawer(prisma, {
      id,
      tenantId,
      allowInactive: true,
    });
    assertBranchAllowed(req, drawer.branch_id);

    const [shiftsCount, countsCount, activeLeft] = await Promise.all([
      prisma.shift.count({ where: { drawer_id: id } }),
      prisma.drawerCount.count({ where: { drawer_id: id } }),
      prisma.cashDrawer.count({
        where: { branch_id: drawer.branch_id, is_active: true },
      }),
    ]);

    if (shiftsCount > 0 || countsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `مينفعش تحذف الدرج — عليه ${shiftsCount} وردية و${countsCount} جرد. وقّفه بدل ما تحذفه.`,
      });
    }

    if (drawer.is_active && activeLeft <= 1) {
      return res.status(400).json({
        success: false,
        message: "مينفعش تحذف آخر درج شغّال في الفرع.",
      });
    }

    await prisma.cashDrawer.delete({ where: { id } });
    res.json({ success: true, message: "Drawer deleted." });
  } catch (err) {
    if (err?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message:
          "مينفعش تحذف الدرج — لسه فيه بيانات مربوطة بيه. وقّفه بدل ما تحذفه.",
      });
    }
    next(err);
  }
};

// ═══════════════════════════════════════════
// POST /api/drawers/:id/count — جرد يدوي من المدير
// body: { counted, expected_seen?, note? }
// ═══════════════════════════════════════════
const manualCount = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const id = req.validated.params.id;
    const { counted, expected_seen, note } = req.validated.body;

    const drawer = await loadDrawer(prisma, { id, tenantId });
    assertBranchAllowed(req, drawer.branch_id);

    const expected = await expectedBalance(prisma, drawer);
    if (!expectedMatches(expected_seen, expected)) {
      return res.status(409).json({
        success: false,
        code: "EXPECTED_CHANGED",
        message: "رصيد الدرج اتغيّر — راجع الرقم الجديد.",
        data: { expected },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const { count, variance } = await recordCount(tx, {
        drawer,
        tenantId,
        userId: req.user.id,
        reason: "manual",
        expected,
        counted,
        note: note || null,
      });

      // أي حد شغال على الدرج لازم يعرف إن المدير عدّ
      await flagOthersForAck(tx, { drawerId: drawer.id });

      return { count, variance };
    });

    res.status(201).json({
      success: true,
      message: "Drawer counted.",
      data: {
        expected,
        counted: round2(counted),
        variance: result.variance,
        count: result.count,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getDrawers,
  getDrawerState,
  getDrawerCounts,
  getDrawerLedger,
  createDrawer,
  updateDrawer,
  deleteDrawer,
  manualCount,
};
