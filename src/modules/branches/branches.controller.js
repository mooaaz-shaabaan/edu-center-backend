// src/modules/branches/branches.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");

// اللي ليهم حق يشوفوا الأرقام المالية
const MANAGER_ROLES = ["super_admin", "owner", "admin"];

/**
 * الفروع اللي اليوزر مسموح له بيها.
 * null = كل فروع السنتر (الأونر والسوبر أدمن)
 *
 * ⚠ كانت نسخة محلية بتقرا branchAccess بس، من غير user.branch_id —
 *   فاليوزر اللي اتغيّر فرعه من updateUser (بيغيّر branch_id من غير
 *   ما يعمل صف في branch_access) كان بيرجع بصفر فروع من GET /branches
 *   ويعلّق على شاشة اختيار الفرع للأبد، في حين إن الحضور والمديولز
 *   التانية (بتستخدم getAllowedBranchIds) بتعتبر الفرع ده مسموح.
 *   دلوقتي مصدر واحد للحقيقة.
 */
const accessibleBranchIds = (req) => getAllowedBranchIds(req.user);

/** بيرمي 403 لو الفرع مش من فروع اليوزر */
const assertBranchAccess = (req, branchId) => {
  const allowed = accessibleBranchIds(req);
  if (allowed === null) return;
  if (!allowed.includes(branchId)) {
    const err = new Error("You don't have access to this branch.");
    err.status = 403;
    throw err;
  }
};

/**
 * الفرع موجود في السنتر وشغّال؟
 *
 * ⚠ استخدم دي في أي كنترولر بيسجّل داتا على فرع
 *   (students · payments · attendance · courses).
 *   إخفاء الفرع الموقوف من الـ UI مش حماية — لازم السيرفر يرفض.
 */
const assertBranchUsable = async (req, branchId) => {
  const branch = await prisma.branch.findFirst({
    where: { ...tenantWhere(req), id: branchId },
    select: { id: true, name: true, is_active: true },
  });

  if (!branch) {
    const err = new Error("Branch not found in this center.");
    err.status = 404;
    throw err;
  }

  if (!branch.is_active) {
    const err = new Error(`الفرع "${branch.name}" موقوف — برجاء اختيار فرع شغّال.`);
    err.status = 400;
    throw err;
  }

  assertBranchAccess(req, branchId);
  return branch;
};

// ═══════════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════════

/**
 * GET /branches
 *
 * ?is_active=true  → الشغّال بس
 * ?is_active=false → الموقوف بس
 * من غير الباراميتر → الكل
 *
 * ⚠ كان بيفلتر `is_active: true` دايماً، فالفرع كان بيختفي من
 *   شاشة الفروع أول ما توقفه ومفيش طريقة ترجّعه تاني.
 *
 * ?with_stats=true → بيرجّع الإحصائيات جوه كل فرع في نفس الطلب
 *   بدل طلب منفصل لكل فرع (N+1).
 */
const getBranches = async (req, res, next) => {
  try {
    const { is_active, with_stats } = req.validated?.query || {};
    const where = { ...tenantWhere(req) };

    if (is_active === true || is_active === "true") where.is_active = true;
    if (is_active === false || is_active === "false") where.is_active = false;

    // الموظف يشوف فروعه بس
    const allowed = accessibleBranchIds(req);
    if (allowed !== null) where.id = { in: allowed };

    const branches = await prisma.branch.findMany({
      where,
      orderBy: [{ is_active: "desc" }, { created_at: "asc" }],
    });

    const wantsStats = with_stats === true || with_stats === "true";
    if (!wantsStats || branches.length === 0) {
      return res.json({ success: true, data: branches });
    }

    // ⚠ /branches/:id/stats محمي بـ MANAGERS، فلازم نفس الحماية هنا —
    //   من غيرها الريسبشن كان يقدر يجيب إيرادات كل الفروع
    //   من `GET /branches?with_stats=true`
    if (!MANAGER_ROLES.includes(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: "You don't have access to branch statistics.",
      });
    }

    const ids = branches.map((b) => b.id);
    const scope = { ...tenantWhere(req), branch_id: { in: ids } };

    const [students, payments, attendance] = await Promise.all([
      prisma.student.groupBy({
        by: ["branch_id"],
        where: { ...scope, is_active: true },
        _count: { _all: true },
      }),
      prisma.payment.groupBy({
        by: ["branch_id"],
        where: scope,
        _sum: { amount: true },
      }),
      // ⚠ المتأخر حضور برضه — كان `status: "present"` بس،
      //   فالمتأخرين مكانوش بيتعدّوا هنا رغم إنهم محسوبين
      //   حاضرين في الداشبورد. الرقمين كانوا مختلفين.
      prisma.attendance.groupBy({
        by: ["branch_id"],
        where: { ...scope, status: { in: ["present", "late"] } },
        _count: { _all: true },
      }),
    ]);

    const byBranch = (rows, pick) =>
      Object.fromEntries(rows.map((r) => [r.branch_id, pick(r)]));

    const studentsMap = byBranch(students, (r) => r._count._all);
    const paymentsMap = byBranch(payments, (r) => Number(r._sum.amount || 0));
    const attendanceMap = byBranch(attendance, (r) => r._count._all);

    res.json({
      success: true,
      data: branches.map((b) => ({
        ...b,
        total_students: studentsMap[b.id] || 0,
        total_revenue: paymentsMap[b.id] || 0,
        total_attendance: attendanceMap[b.id] || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
};

const createBranch = async (req, res, next) => {
  try {
    const { name, address, phone } = req.validated.body;
    const tenantId = requireTenantId(req);

    // اسم مكرر في نفس السنتر بيلخبط كل شاشة بتختار فرع
    const duplicate = await prisma.branch.findFirst({
      where: { tenant_id: tenantId, name: name.trim() },
      select: { id: true },
    });
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: `فيه فرع بنفس الاسم "${name.trim()}" موجود بالفعل.`,
      });
    }

    const branch = await prisma.branch.create({
      data: {
        tenant_id: tenantId, // ← الختم
        name: name.trim(),
        address: address || null,
        phone: phone || null,
      },
    });

    res
      .status(201)
      .json({ success: true, message: "Branch created.", data: branch });
  } catch (err) {
    next(err);
  }
};

const updateBranch = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { name, address, phone, is_active } = req.validated.body;

    const existing = await prisma.branch.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, is_active: true },
    });
    assertSameTenant(req, existing);
    assertBranchAccess(req, id);

    // اسم مكرر — مع استثناء الفرع نفسه
    if (name !== undefined) {
      const duplicate = await prisma.branch.findFirst({
        where: {
          tenant_id: existing.tenant_id,
          name: name.trim(),
          id: { not: id },
        },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: `فيه فرع بنفس الاسم "${name.trim()}" موجود بالفعل.`,
        });
      }
    }

    // ما ينفعش السنتر يفضل من غير ولا فرع شغّال
    if (is_active === false && existing.is_active === true) {
      const activeCount = await prisma.branch.count({
        where: { tenant_id: existing.tenant_id, is_active: true },
      });
      if (activeCount <= 1) {
        return res.status(400).json({
          success: false,
          message: "مينفعش توقف آخر فرع شغّال في السنتر.",
        });
      }
    }

    const branch = await prisma.branch.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(address !== undefined && { address: address || null }),
        ...(phone !== undefined && { phone: phone || null }),
        ...(is_active !== undefined && { is_active }),
      },
    });

    res.json({ success: true, message: "Branch updated.", data: branch });
  } catch (err) {
    next(err);
  }
};

/**
 * عدّاد آمن — لو الموديل مش موجود في الـ schema بيرجّع 0
 * بدل ما يرمي TypeError ويوقّع الريكوست كله بـ 500.
 */
const safeCount = (model, where) =>
  prisma[model]?.count ? prisma[model].count({ where }) : Promise.resolve(0);

/**
 * كل حاجة مربوطة بالفرع لازم تتفحص قبل الحذف.
 *
 * ⚠ كانت الطلبة والمواد والدفعات بس. الحضور المدفوع من المحفظة
 *   مابيعملش صف في Payment، فالفرع اللي فيه حضور محفظة بس كان
 *   بيعدّي التلات فحوصات ويقع على FK error بـ 500.
 */
const DELETE_BLOCKERS = [
  { model: "student", label: (n) => `فيه ${n} طالب مسجّل` },
  { model: "course", label: (n) => `فيه ${n} مادة` },
  { model: "payment", label: (n) => `فيه ${n} عملية دفع مسجّلة` },
  { model: "attendance", label: (n) => `فيه ${n} سجل حضور` },
  { model: "room", label: (n) => `فيه ${n} قاعة` },
  { model: "shift", label: (n) => `فيه ${n} وردية` },
  { model: "registration", label: (n) => `فيه ${n} طلب تسجيل` },
  { model: "user", label: (n) => `فيه ${n} مستخدم متعيّن على الفرع` },
];

const deleteBranch = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const existing = await prisma.branch.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, is_active: true },
    });
    assertSameTenant(req, existing);
    assertBranchAccess(req, id);

    // ⚠ كان بيعدّ كل الفروع — يعني ينفع تحذف آخر فرع *شغّال*
    //   طالما فيه فرع موقوف تاني، والسنتر يفضل من غير ولا فرع يشتغل عليه.
    const [totalCount, activeCount] = await Promise.all([
      prisma.branch.count({ where: { tenant_id: existing.tenant_id } }),
      prisma.branch.count({
        where: { tenant_id: existing.tenant_id, is_active: true },
      }),
    ]);

    if (totalCount <= 1) {
      return res.status(400).json({
        success: false,
        message: "مينفعش تحذف آخر فرع في السنتر.",
      });
    }

    if (existing.is_active && activeCount <= 1) {
      return res.status(400).json({
        success: false,
        message: "مينفعش تحذف آخر فرع شغّال في السنتر.",
      });
    }

    const counts = await Promise.all(
      DELETE_BLOCKERS.map((b) => safeCount(b.model, { branch_id: id }))
    );

    const blocked = DELETE_BLOCKERS.map((b, i) => ({ ...b, count: counts[i] }))
      .filter((b) => b.count > 0);

    if (blocked.length > 0) {
      const details = blocked.map((b) => b.label(b.count)).join("، ");
      return res.status(400).json({
        success: false,
        message: `مينفعش تحذف الفرع — ${details}. وقّف الفرع بدل ما تحذفه.`,
      });
    }

    await prisma.branch.delete({ where: { id } });
    res.json({ success: true, message: "Branch deleted." });
  } catch (err) {
    // شبكة أمان: أي علاقة منسيّة في القايمة فوق تطلع رسالة مفهومة
    // بدل 500 من Prisma
    if (err?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message:
          "مينفعش تحذف الفرع — لسه فيه بيانات مربوطة بيه. وقّف الفرع بدل ما تحذفه.",
      });
    }
    next(err);
  }
};

const getBranchStats = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const branch = await prisma.branch.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, branch);
    assertBranchAccess(req, id);

    // الـ tenant_id في كل استعلام — حماية زيادة حتى لو الفحص فوق اتغيّر
    const scope = { ...tenantWhere(req), branch_id: id };

    const [students, payments, attendance] = await Promise.all([
      prisma.student.count({ where: { ...scope, is_active: true } }),
      prisma.payment.aggregate({ where: scope, _sum: { amount: true } }),
      // المتأخر حضور برضه — نفس تعريف الداشبورد
      prisma.attendance.count({
        where: { ...scope, status: { in: ["present", "late"] } },
      }),
    ]);

    res.json({
      success: true,
      data: {
        branch_id: id,
        total_students: students,
        total_revenue: Number(payments._sum.amount || 0),
        total_attendance: attendance,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════

const getRooms = async (req, res, next) => {
  try {
    const { branch_id } = req.validated.query;
    const where = { ...tenantWhere(req) };

    const allowed = accessibleBranchIds(req);

    if (branch_id) {
      assertBranchAccess(req, branch_id);
      where.branch_id = branch_id;
    } else if (allowed !== null) {
      where.branch_id = { in: allowed };
    }

    const rooms = await prisma.room.findMany({
      where,
      orderBy: { created_at: "asc" },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.json({ success: true, data: rooms });
  } catch (err) {
    next(err);
  }
};

const createRoom = async (req, res, next) => {
  try {
    const { name, capacity, branch_id } = req.validated.body;
    const tenantId = requireTenantId(req);

    // الفرع لازم تابع لنفس السنتر وشغّال
    await assertBranchUsable(req, branch_id);

    const room = await prisma.room.create({
      data: {
        tenant_id: tenantId, // ← الختم
        name,
        capacity: capacity ?? null,
        branch_id,
      },
      include: { branch: { select: { id: true, name: true } } },
    });

    res
      .status(201)
      .json({ success: true, message: "Room created.", data: room });
  } catch (err) {
    next(err);
  }
};

const updateRoom = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { name, capacity } = req.validated.body;

    const existing = await prisma.room.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, branch_id: true },
    });
    assertSameTenant(req, existing);
    assertBranchAccess(req, existing.branch_id);

    const room = await prisma.room.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(capacity !== undefined && { capacity }),
      },
    });

    res.json({ success: true, message: "Room updated.", data: room });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
  getBranchStats,
  getRooms,
  createRoom,
  updateRoom,
  // للاستخدام في الموديولز التانية
  assertBranchUsable,
  assertBranchAccess,
  accessibleBranchIds,
};