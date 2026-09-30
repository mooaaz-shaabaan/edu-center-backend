// src/modules/users/users.controller.js
const prisma = require("../../config/db");
const bcrypt = require("bcryptjs");
const { tenantWhere, requireTenantId, assertSameTenant } =
  require("../../core/tenant");
const { isConnected, endSession, closeUserStreams } =
  require("../../core/session");
const { notify, notifyUser } = require("../../core/sse");
const { closeShiftWithTotals } = require("../shifts/shifts.service");

// مصدر واحد للحقيقة — الميدل وير هو اللي بيطبّق نفس المنع وقت الطلب
const { FEATURES_BLOCKED_BY_ROLE, effectiveFeatures } =
  require("../../middlewares/rbac");

// ─────────────────────────────────────────────────────────
// ثوابت الأدوار والصلاحيات
// ─────────────────────────────────────────────────────────

// مين يقدر ينشئ/يعدّل مين
const ASSIGNABLE_ROLES_BY_ROLE = {
  super_admin:  ["owner", "admin", "receptionist"],
  owner:        ["owner", "admin", "receptionist"],
  admin:        ["receptionist"],
  receptionist: [],
};

// الرُتب — عشان نمنع الأقل رتبة إنه يعدّل الأعلى
const ROLE_RANK = {
  super_admin:  4,
  owner:        3,
  admin:        2,
  receptionist: 1,
};

// الفيتشرز المسموح بيها (whitelist — أي حاجة برّاها بترفض)
// لازم تتطابق مع AppFeatures في الفلاتر
const ALLOWED_FEATURES = [
  "students",
  "registrations", // ← جديد: طلبات التسجيل الجاية من الموقع
  "attendance",
  "courses",
  "semesters",
  "schedules",
  "payments",
  "expenses",
  "reports",
  "shifts",
  "users",
  "branches",
];

const DEFAULT_FEATURES = "attendance,payments";

// الأدوار اللي عندها وصول ضمني لكل فروع السنتر
const FULL_ACCESS_ROLES = ["super_admin", "owner"];

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const parseFeatures = (str) =>
  (str || "").split(",").map((f) => f.trim()).filter(Boolean);

const httpError = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// يتأكد إن الإيميل على دومين السنتر
const assertEmailMatchesTenantDomain = async (email, tenantId) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { email_domain: true },
  });

  if (!tenant?.email_domain) return;

  const domain = email.split("@")[1]?.toLowerCase();
  if (domain !== tenant.email_domain.toLowerCase()) {
    throw httpError(
      `Email must be on the center's domain (@${tenant.email_domain}).`,
      400
    );
  }
};

/**
 * الفروع اللي اليوزر الحالي يقدر يمنحها لحد تاني.
 * - super_admin / owner → كل فروع السنتر
 * - admin              → فروعه من branch_access + branch_id بتاعه
 * - receptionist       → ولا حاجة
 */
const getGrantableBranchIds = async (req, tenantId) => {
  if (FULL_ACCESS_ROLES.includes(req.user.role)) {
    const branches = await prisma.branch.findMany({
      where: { tenant_id: tenantId, is_active: true },
      select: { id: true },
    });
    return branches.map((b) => b.id);
  }

  if (req.user.role !== "admin") return [];

  // اتحاد الاتنين — مش واحد أو التاني
  const ids = new Set();
  if (req.user.branch_id) ids.add(req.user.branch_id);
  (req.user.branchAccess || []).forEach((ba) => ids.add(ba.branchId));
  return [...ids];
};

/**
 * الفيتشرز اللي اليوزر الحالي يقدر يمنحها على فرع معيّن.
 * - super_admin / owner → كل الفيتشرز
 * - admin              → اللي هو واخدها على الفرع ده بالظبط
 */
const getGrantableFeatures = (req, branchId) => {
  if (FULL_ACCESS_ROLES.includes(req.user.role)) return [...ALLOWED_FEATURES];

  const access = (req.user.branchAccess || []).find(
    (ba) => ba.branchId === branchId
  );
  // الممنوع على دوره هو مايقدرش يمنحه لحد تاني
  return access ? effectiveFeatures(req.user.role, access.features) : [];
};

/**
 * مين يشوف مين في قايمة المستخدمين.
 *
 * ⚠ الرتبة بتحدد مين يفتح الشاشة، مش مين يظهر فيها. من غير
 *   الفلتر ده أدمن فرع واحد كان بيشوف موظفين وإيميلات كل
 *   فروع السنتر — مايقدرش يعدّل عليهم، بس شايفهم.
 *
 * نفس قاعدة assertCanManage بالظبط: نفسه + اللي أنشأهم +
 * اللي في فروعه.
 */
const visibleUsersWhere = async (req) => {
  if (FULL_ACCESS_ROLES.includes(req.user.role)) return {};

  const branchIds = await getGrantableBranchIds(req, resolveTenantId(req));

  return {
    OR: [
      { id: req.user.id },
      { created_by: req.user.id },
      if_branches(branchIds),
    ].flat().filter(Boolean),
  };
};

/// فروعه — سواء كفرع أساسي أو في صلاحيات الفروع
const if_branches = (ids) =>
  ids.length === 0
    ? []
    : [
        { branch_id: { in: ids } },
        { branch_access: { some: { branch_id: { in: ids } } } },
      ];

/**
 * يتأكد إن اليوزر الحالي يقدر يدير الهدف:
 *   - نفسه → مسموح (والحدود بتاعة التعديل على النفس في كل endpoint)
 *   - لازم رتبته أعلى من الهدف
 *   - الأدمن: بس الموظفين اللي في فروع هو واخد عليها أكسس
 *     (لو الموظف مالوش أي فرع → بس الأدمن اللي أنشأه)
 */
const assertCanManage = async (req, target) => {
  if (target.id === req.user.id) return;

  if (ROLE_RANK[target.role] >= ROLE_RANK[req.user.role]) {
    throw httpError("You cannot modify a user at your level or above.", 403);
  }

  if (FULL_ACCESS_ROLES.includes(req.user.role)) return;

  const t = await prisma.user.findUnique({
    where: { id: target.id },
    select: {
      branch_id: true,
      created_by: true,
      branch_access: { select: { branch_id: true } },
    },
  });

  const targetBranches = new Set(
    [t.branch_id, ...t.branch_access.map((ba) => ba.branch_id)].filter(Boolean)
  );

  if (targetBranches.size === 0) {
    if (t.created_by !== req.user.id) {
      throw httpError("You cannot manage this user.", 403);
    }
    return;
  }

  const grantable = await getGrantableBranchIds(req, target.tenant_id);
  if (![...targetBranches].some((id) => grantable.includes(id))) {
    throw httpError("You cannot manage this user.", 403);
  }
};

/**
 * يتحقق من الفروع والفيتشرز المطلوبة قبل ما نكتب أي حاجة.
 * بيرجّع array جاهزة للكتابة: [{ branch_id, features }]
 *
 * targetRole مهم: فيه فيتشرز ممنوعة على أدوار معيّنة مهما كان
 * اللي بيمنحها (مثلاً التقارير على الاستقبال).
 */
const validateBranchGrants = async (req, tenantId, grants, targetRole) => {
  if (!grants || grants.length === 0) return [];

  const grantable = await getGrantableBranchIds(req, tenantId);
  const blockedForRole = FEATURES_BLOCKED_BY_ROLE[targetRole] || [];

  // كل الفروع المطلوبة لازم تكون في نفس السنتر
  const branchIds = grants.map((g) => g.branch_id);
  const validBranches = await prisma.branch.findMany({
    where: { id: { in: branchIds }, tenant_id: tenantId },
    select: { id: true },
  });
  const validIds = new Set(validBranches.map((b) => b.id));

  return grants.map((g) => {
    if (!validIds.has(g.branch_id)) {
      throw httpError(`Branch ${g.branch_id} not found in this center.`, 400);
    }

    if (!grantable.includes(g.branch_id)) {
      throw httpError(
        `You don't have access to branch ${g.branch_id}, so you can't grant it.`,
        403
      );
    }

    const requested = g.features?.length ? g.features : parseFeatures(DEFAULT_FEATURES);

    // 1) لازم تكون من الـ whitelist
    const unknown = requested.filter((f) => !ALLOWED_FEATURES.includes(f));
    if (unknown.length) {
      throw httpError(`Unknown feature(s): ${unknown.join(", ")}`, 400);
    }

    // 2) مش ممنوعة على دور الهدف
    const forbidden = requested.filter((f) => blockedForRole.includes(f));
    if (forbidden.length) {
      throw httpError(
        `الدور "${targetRole}" مايقدرش ياخد: ${forbidden.join(", ")}`,
        400
      );
    }

    // 3) لازم تكون من ضمن اللي أنا واخدها على الفرع ده
    const mine = getGrantableFeatures(req, g.branch_id);
    const notMine = requested.filter((f) => !mine.includes(f));
    if (notMine.length) {
      throw httpError(
        `You don't have these feature(s) on this branch: ${notMine.join(", ")}`,
        403
      );
    }

    return { branch_id: g.branch_id, features: requested.join(",") };
  });
};

// ─────────────────────────────────────────────────────────
// GET /api/users
// ─────────────────────────────────────────────────────────
const getUsers = async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { ...tenantWhere(req), ...(await visibleUsersWhere(req)) },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        is_active: true,
        branch_id: true,
        tenant_id: true,
        created_by: true,
        created_at: true,
        archived_at: true,
        last_seen_at: true,
        branch_access: {
          select: {
            branch_id: true,
            features: true,
            branch: { select: { id: true, name: true } },
          },
        },
      },
    });

    const now = Date.now();
    const data = users.map(({ branch_access, last_seen_at, ...user }) => ({
      ...user,
      is_connected: isConnected(last_seen_at, now),
      branch_access: branch_access.map((ba) => ({
        branch_id: ba.branch_id,
        branch_name: ba.branch.name,
        // صفوف قديمة ممكن يكون فيها فيتشر بقى ممنوع على دوره —
        // مانعرضهاش عشان الشاشة تقول الحقيقة اللي السيرفر بيطبّقها
        features: effectiveFeatures(user.role, parseFeatures(ba.features)),
      })),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/users
// body: { name, email, password, role, branch_id?, branches? }
// branches: [{ branch_id, features: [...] }]  أو  [1, 2, 3]
// ─────────────────────────────────────────────────────────
const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role: userRole, branch_id, branches } =
      req.validated.body;

    const tenantId = requireTenantId(req);

    // 1) هل أقدر أنشئ الرول ده أصلاً؟
    const allowedRoles = ASSIGNABLE_ROLES_BY_ROLE[req.user.role] || [];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: `You cannot create users with role: ${userRole}`,
      });
    }

    // 2) الدومين
    await assertEmailMatchesTenantDomain(email, tenantId);

    // 3) نطبّع شكل branches — يقبل [1,2] أو [{branch_id, features}]
    const normalized = (branches || []).map((b) =>
      typeof b === "number"
        ? { branch_id: b, features: parseFeatures(DEFAULT_FEATURES) }
        : { branch_id: b.branch_id, features: b.features || [] }
    );

    // 4) الفرع الأساسي (branch_id) لازم يكون ضمن المسموح كمان
    if (branch_id && !normalized.some((g) => g.branch_id === branch_id)) {
      normalized.push({
        branch_id,
        features: parseFeatures(DEFAULT_FEATURES),
      });
    }

    // 5) تحقّق كامل قبل أي كتابة
    const grants = await validateBranchGrants(
      req,
      tenantId,
      normalized,
      userRole
    );

    const hashed = await bcrypt.hash(password, 12);

    // 6) كتابة واحدة (nested write = transaction ضمني)
    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase().trim(),
        password: hashed,
        role: userRole,
        tenant_id: tenantId,
        branch_id: branch_id || null,
        created_by: req.user.id,
        branch_access: {
          create: grants.map((g) => ({
            tenant_id: tenantId,
            branch_id: g.branch_id,
            features: g.features,
            granted_by: req.user.id,
          })),
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        is_active: true,
        branch_id: true,
        tenant_id: true,
        branch_access: {
          select: {
            branch_id: true,
            features: true,
            branch: { select: { name: true } },
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      message: "User created.",
      data: {
        ...user,
        branch_access: user.branch_access.map((ba) => ({
          branch_id: ba.branch_id,
          branch_name: ba.branch.name,
          features: parseFeatures(ba.features),
        })),
      },
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
      });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// PUT /api/users/:id
// ─────────────────────────────────────────────────────────
const updateUser = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { name, email, is_active, role: userRole, branch_id } =
      req.validated.body;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, role: true, is_active: true },
    });
    assertSameTenant(req, target);
    await assertCanManage(req, target);

    // على نفسي: الاسم والإيميل بس (الباسورد من /password)
    if (
      target.id === req.user.id &&
      (userRole !== undefined || is_active !== undefined || branch_id !== undefined)
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your name, email and password.",
      });
    }

    // الإيميل: على دومين السنتر
    if (email !== undefined) {
      await assertEmailMatchesTenantDomain(email, target.tenant_id);
    }

    // لو بيغيّر الرول
    if (userRole !== undefined) {
      const allowedRoles = ASSIGNABLE_ROLES_BY_ROLE[req.user.role] || [];
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          message: "You cannot assign this role.",
        });
      }
    }

    // مش هتقفل حساب نفسك
    if (is_active === false && target.id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot deactivate your own account.",
      });
    }

    // الفرع لازم يكون في نفس السنتر + من ضمن اللي أقدر أمنحه
    if (branch_id !== undefined && branch_id !== null) {
      const branch = await prisma.branch.findFirst({
        where: { id: branch_id, tenant_id: target.tenant_id },
        select: { id: true },
      });
      if (!branch) {
        return res.status(400).json({
          success: false,
          message: "Branch not found in this center.",
        });
      }

      const grantable = await getGrantableBranchIds(req, target.tenant_id);
      if (!grantable.includes(branch_id)) {
        return res.status(403).json({
          success: false,
          message: "You don't have access to this branch.",
        });
      }
    }

    // ⚠ النزول في الرتبة (أدمن → استقبال) ممكن يخلّيه ماسك فيتشر
    //   ممنوع على رتبته الجديدة. الميدل وير بيتجاهله وقت الطلب،
    //   بس بننضّف الصفوف هنا كمان عشان الشاشة ماتوريش حاجة وهمية.
    const roleChanged = userRole !== undefined && userRole !== target.role;
    const blockedAfter = roleChanged
      ? FEATURES_BLOCKED_BY_ROLE[userRole] || []
      : [];

    // التعطيل: الصلاحيات والفرع بيفضلوا زي ما هما،
    // بس الجلسة المفتوحة بتتقفل واليوزر بيتخرج فوراً
    const deactivating = is_active === false && target.is_active;

    let closedShift = null;
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(email !== undefined && { email: email.toLowerCase().trim() }),
          ...(is_active !== undefined && { is_active }),
          ...(userRole !== undefined && { role: userRole }),
          ...(branch_id !== undefined && { branch_id }),
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          is_active: true,
          branch_id: true,
        },
      });

      if (blockedAfter.length) {
        const rows = await tx.userBranchAccess.findMany({
          where: { user_id: id },
          select: { id: true, features: true },
        });
        for (const row of rows) {
          const kept = parseFeatures(row.features).filter(
            (f) => !blockedAfter.includes(f)
          );
          if (kept.length === parseFeatures(row.features).length) continue;
          // فرع من غير ولا صلاحية مالوش معنى — يتشال
          if (kept.length === 0) {
            await tx.userBranchAccess.delete({ where: { id: row.id } });
          } else {
            await tx.userBranchAccess.update({
              where: { id: row.id },
              data: { features: kept.join(",") },
            });
          }
        }
      }

      if (deactivating) {
        const open = await tx.shift.findFirst({
          where: { user_id: id, closed_at: null },
        });
        if (open) closedShift = await closeShiftWithTotals(tx, open, req.user.id);
        await endSession(id, tx);
      }

      return updated;
    });

    if (deactivating) {
      // البرنامج عند الموظف يرجع لشاشة الدخول فوراً (نفس الخروج الإجباري)
      notifyUser(id, "force_logout", {});
      closeUserStreams(id);
      notify("shifts_updated", {}, target.tenant_id);
      if (closedShift) notify("payments_updated", {}, target.tenant_id);
    }

    res.json({ success: true, message: "User updated.", data: user });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
      });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// PUT /api/users/:id/password
// ─────────────────────────────────────────────────────────
const resetUserPassword = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { password } = req.validated.body;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, role: true },
    });
    assertSameTenant(req, target);
    await assertCanManage(req, target);

    const hashed = await bcrypt.hash(password, 12);

    // باسوردي أنا → بيتغير بس، وجلستي تفضل شغالة
    if (target.id === req.user.id) {
      await prisma.user.update({
        where: { id },
        data: { password: hashed },
      });
      return res.json({ success: true, message: "Password reset successfully." });
    }

    // باسورد حد تاني → بيتخرج من البرنامج ويقدر يدخل على طول بالباسورد الجديد
    // (endSession بيفضّي last_seen_at — غير كده كان هيتقفل 5 دقايق)
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { password: hashed } });
      await endSession(id, tx);
    });
    closeUserStreams(id);

    res.json({ success: true, message: "Password reset successfully." });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// GET /api/users/:id/branch-access
// بيرجّع *كل* فروع السنتر مع حالة كل واحد — عشان شاشة السويتشات
// ─────────────────────────────────────────────────────────
const getUserBranchAccess = async (req, res, next) => {
  try {
    const userId = req.validated.params.id;

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        tenant_id: true,
        role: true,
        branch_access: {
          select: { id: true, branch_id: true, features: true },
        },
      },
    });
    assertSameTenant(req, target);

    // كل فروع السنتر
    const branches = await prisma.branch.findMany({
      where: { tenant_id: target.tenant_id, is_active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    // الفروع اللي أنا (اللي بمنح) أقدر أتحكم فيها
    const grantable = await getGrantableBranchIds(req, target.tenant_id);

    // الممنوع على دور الهدف — ماينفعش يتعرض كخيار متاح
    const blockedForTarget = FEATURES_BLOCKED_BY_ROLE[target.role] || [];

    const accessMap = new Map(
      target.branch_access.map((ba) => [ba.branch_id, ba])
    );

    const data = branches.map((branch) => {
      const access = accessMap.get(branch.id);
      return {
        branch_id: branch.id,
        branch_name: branch.name,
        granted: !!access,
        features: access
          ? effectiveFeatures(target.role, parseFeatures(access.features))
          : [],
        // الفيتشرز اللي أقدر أديها على الفرع ده (لتعطيل الاختيارات في الـ UI)
        grantable_features: getGrantableFeatures(req, branch.id).filter(
          (f) => !blockedForTarget.includes(f)
        ),
        // هل أقدر أعدّل الفرع ده أصلاً
        can_manage: grantable.includes(branch.id),
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// PUT /api/users/:id/branch-access/:branchId
// upsert — بيمنح الفرع لو مش موجود، وبيحدّث الفيتشرز لو موجود
// body: { features: ["attendance", "payments"] }
// ─────────────────────────────────────────────────────────
const updateUserBranchAccess = async (req, res, next) => {
  try {
    const userId = req.validated.params.id;
    const branchId = req.validated.params.branchId;
    const { features } = req.validated.body;

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenant_id: true, role: true },
    });
    assertSameTenant(req, target);
    await assertCanManage(req, target);

    const [grant] = await validateBranchGrants(
      req,
      target.tenant_id,
      [{ branch_id: branchId, features: features || [] }],
      target.role
    );

    const saved = await prisma.userBranchAccess.upsert({
      where: {
        uq_user_branch: { user_id: userId, branch_id: branchId },
      },
      create: {
        tenant_id: target.tenant_id,
        user_id: userId,
        branch_id: branchId,
        features: grant.features,
        granted_by: req.user.id,
      },
      update: {
        features: grant.features,
        granted_by: req.user.id,
      },
      select: {
        id: true,
        branch_id: true,
        features: true,
        branch: { select: { name: true } },
      },
    });

    res.json({
      success: true,
      message: "Branch access saved.",
      data: {
        branch_id: saved.branch_id,
        branch_name: saved.branch.name,
        features: parseFeatures(saved.features),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// DELETE /api/users/:id/branch-access/:branchId
// ─────────────────────────────────────────────────────────
const removeUserBranchAccess = async (req, res, next) => {
  try {
    const userId = req.validated.params.id;
    const branchId = req.validated.params.branchId;

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenant_id: true, role: true },
    });
    assertSameTenant(req, target);
    await assertCanManage(req, target);

    // لازم يكون الفرع من ضمن اللي أقدر أتحكم فيه
    const grantable = await getGrantableBranchIds(req, target.tenant_id);
    if (!grantable.includes(branchId)) {
      return res.status(403).json({
        success: false,
        message: "You don't have access to this branch.",
      });
    }

    await prisma.userBranchAccess.delete({
      where: {
        uq_user_branch: { user_id: userId, branch_id: branchId },
      },
    });

    res.json({ success: true, message: "Branch access removed." });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "User does not have access to this branch.",
      });
    }
    next(err);
  }
};
// ─────────────────────────────────────────────────────────
// POST /api/users/:id/archive
// ─────────────────────────────────────────────────────────
const archiveUser = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, role: true, archived_at: true },
    });
    assertSameTenant(req, target);
    await assertCanManage(req, target);

    if (target.id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot archive your own account.",
      });
    }

    if (target.archived_at) {
      return res.status(400).json({
        success: false,
        message: "User is already archived.",
      });
    }

    await prisma.$transaction([
      // 1) اقفل أي شيفت مفتوح
      prisma.shift.updateMany({
        where: { user_id: id, closed_at: null },
        data: { closed_at: new Date(), sync_status: "synced" },
      }),
      // 2) شيل كل صلاحيات الفروع
      prisma.userBranchAccess.deleteMany({ where: { user_id: id } }),
      // 3) أرشف واطرده من أي جلسة شغالة
      prisma.user.update({
        where: { id },
        data: {
          archived_at: new Date(),
          is_active: false,
          branch_id: null,
          token_version: { increment: 1 },
        },
      }),
      prisma.refreshToken.updateMany({
        where: { user_id: id, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);

    res.json({ success: true, message: "User archived." });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/users/:id/restore
// ─────────────────────────────────────────────────────────
const restoreUser = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, role: true, archived_at: true },
    });
    assertSameTenant(req, target);
    await assertCanManage(req, target);

    if (!target.archived_at) {
      return res.status(400).json({
        success: false,
        message: "User is not archived.",
      });
    }

    // بيرجع معطّل ومن غير صلاحيات — لازم تتظبط تاني بإيدك
    await prisma.user.update({
      where: { id },
      data: { archived_at: null, is_active: false },
    });

    res.json({
      success: true,
      message: "User restored. Set their branch access again.",
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getUsers,
  createUser,
  updateUser,
  resetUserPassword,
  getUserBranchAccess,
  updateUserBranchAccess,
  removeUserBranchAccess,
  ALLOWED_FEATURES,
  ASSIGNABLE_ROLES_BY_ROLE,
  archiveUser,
  restoreUser,
};