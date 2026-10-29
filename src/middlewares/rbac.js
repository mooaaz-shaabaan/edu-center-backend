// src/middlewares/rbac.js
// Role-Based Access Control

const FULL_ACCESS_ROLES = ["super_admin", "owner"];

// ── مجموعات الأدوار ───────────────────────────────────────
// كل اللي بيشتغل في السنتر
const STAFF = ["super_admin", "owner", "admin", "receptionist"];
// المديرين بس — إعدادات وحذف وتقارير
const MANAGERS = ["super_admin", "owner", "admin"];

/**
 * فيتشرز ممنوعة على دور معيّن مهما كان اللي منحها.
 *
 * ⚠ ليه هنا مش في users.controller بس؟ لأن منع المنح بيوقف
 *   الجديد بس — اللي واخد الصلاحية فعلاً قبل التغيير هيفضل
 *   ماسكها لحد ما حد يعدّل الصف بإيده. الفلترة هنا معناها إن
 *   الصف القديم نفسه مابيعملش حاجة.
 *
 * لازم تطابق FeaturePolicy في الفلاتر.
 */
const FEATURES_BLOCKED_BY_ROLE = {
  receptionist: ["reports"],
};

/** الفيتشرز الفعلية بعد ما نشيل الممنوع على الدور ده */
const effectiveFeatures = (role, features) => {
  const list = Array.isArray(features) ? features : [];
  const blocked = FEATURES_BLOCKED_BY_ROLE[role] || [];
  return blocked.length ? list.filter((f) => !blocked.includes(f)) : list;
};

/// أسماء الرتب بالعربي — عشان الرسالة تقول للمستخدم هو مين
const ROLE_AR = {
  super_admin: "مالك النظام",
  owner: "صاحب السنتر",
  admin: "المدير",
  receptionist: "موظف الاستقبال",
};

const deny = (res, message, extra = {}) =>
  res.status(403).json({ success: false, message, ...extra });

const unauthorized = (res) =>
  res.status(401).json({
    success: false,
    message: "Access denied. No token provided.",
  });

/**
 * بيقرا branch_id من الريكوست.
 * الترتيب مهم: الـ query الأول لأن الكنترولرز بتقرا منها.
 */
const resolveBranchId = (req) => {
  const raw =
    req.query?.branch_id ??
    req.body?.branch_id ??
    req.params?.branchId ??
    req.params?.branch_id;

  if (raw === undefined || raw === null || raw === "") return null;

  const id = parseInt(raw, 10);
  return Number.isInteger(id) ? id : null;
};

/**
 * الأدوار المسموح لها بس
 * requireRole("owner", "admin")
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user?.role) return unauthorized(res);

    const userRole = String(req.user.role).toLowerCase();
    const isAllowed = allowedRoles.some(
      (r) => String(r).toLowerCase() === userRole,
    );

    if (!isAllowed) {
      // ⚠ الرسالة كانت إنجليزية وعامة: «Forbidden. You don't have
      //   permission». المستخدم بيشوفها جوه ديالوج عربي، ومش عارف
      //   إن السبب رتبته — فبيفتكر إن فيه حاجة ناقصة في الفورم
      //   وبيفضل يحاول.
      return deny(
        res,
        `العملية دي مش من صلاحيات ${ROLE_AR[userRole] ?? "حسابك"}.`,
        {
          code: "ROLE_FORBIDDEN",
          requiredRoles: allowedRoles,
          yourRole: req.user.role,
        },
      );
    }

    next();
  };
};

/**
 * صلاحية المستخدم على فرع معيّن لفيتشر معيّن
 * requireBranchAccess("attendance")
 *
 * بيسيب في الريكوست:
 *   req.branchId          → الفرع المتحقق منه (لو اتبعت)
 *   req.allowedBranchIds  → الفروع المسموح بها، أو null = كل الفروع
 *
 * مهم: الكنترولر لازم يفلتر بـ req.allowedBranchIds لما مفيش branch_id محدد،
 * وإلا اليوزر هيشوف فروع مش بتاعته.
 */
/**
 * الفيتشر دي في اشتراك السنتر؟
 *
 * ⚠ ده **فوق** الأدوار كلها: سنتر مادفعش على «التقارير» مفيش حد
 *   فيه يفتحها، ولا صاحب السنتر نفسه. الفحص ده لازم ييجي قبل
 *   FULL_ACCESS_ROLES، وإلا الأونر بيعدّي من فوق الاشتراك.
 *
 *   `req.tenantFeatures === null` → السوبر أدمن، مالوش سقف.
 */
const inTenantPlan = (req, feature) =>
  req.tenantFeatures === null || req.tenantFeatures.includes(feature);

const denyNotInPlan = (res, feature) =>
  res.status(403).json({
    success: false,
    code: "FEATURE_NOT_IN_PLAN",
    message: "الخدمة دي مش في اشتراك السنتر.",
    requiredFeature: feature,
  });

const requireBranchAccess = (requiredFeature) => {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);

    if (!inTenantPlan(req, requiredFeature)) {
      return denyNotInPlan(res, requiredFeature);
    }

    const branchId = resolveBranchId(req);

    // الأونر والسوبر أدمن: وصول ضمني لكل فروع سنترهم
    if (FULL_ACCESS_ROLES.includes(req.user.role)) {
      if (branchId !== null) req.branchId = branchId;
      req.allowedBranchIds = null; // null = مفيش تقييد
      return next();
    }

    const access = Array.isArray(req.user.branchAccess)
      ? req.user.branchAccess
      : [];

    const grantedIds = access
      .filter((ba) =>
        effectiveFeatures(req.user.role, ba.features).includes(requiredFeature),
      )
      .map((ba) => ba.branchId);

    if (grantedIds.length === 0) {
      return deny(res, "Forbidden. You don't have access to this feature.", {
        requiredFeature,
      });
    }

    // مفيش فرع محدد — قيّده على فروعه هو، مش على فرعه الأساسي
    if (branchId === null) {
      req.allowedBranchIds = grantedIds;
      return next();
    }

    if (!grantedIds.includes(branchId)) {
      return deny(
        res,
        "Forbidden. You don't have access to this feature on this branch.",
        { requiredFeature, requestedBranch: branchId },
      );
    }

    req.branchId = branchId;
    req.allowedBranchIds = [branchId];
    req.selectedBranchName = access.find(
      (ba) => ba.branchId === branchId,
    )?.branchName;

    next();
  };
};

/**
 * لازم كل الفيتشرز دي على نفس الفرع
 * requireMultipleFeatures("payments", "reports")
 */
const requireMultipleFeatures = (...requiredFeatures) => {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);

    const missing = requiredFeatures.find((f) => !inTenantPlan(req, f));
    if (missing) return denyNotInPlan(res, missing);

    const branchId = resolveBranchId(req);

    if (FULL_ACCESS_ROLES.includes(req.user.role)) {
      if (branchId !== null) req.branchId = branchId;
      req.allowedBranchIds = null;
      return next();
    }

    const access = Array.isArray(req.user.branchAccess)
      ? req.user.branchAccess
      : [];

    const grantedIds = access
      .filter((ba) => {
        const mine = effectiveFeatures(req.user.role, ba.features);
        return requiredFeatures.every((f) => mine.includes(f));
      })
      .map((ba) => ba.branchId);

    if (grantedIds.length === 0) {
      return deny(
        res,
        "Forbidden. You don't have access to all required features.",
        { requiredFeatures },
      );
    }

    if (branchId === null) {
      req.allowedBranchIds = grantedIds;
      return next();
    }

    if (!grantedIds.includes(branchId)) {
      return deny(
        res,
        "Forbidden. You don't have access to all required features on this branch.",
        { requiredFeatures, requestedBranch: branchId },
      );
    }

    req.branchId = branchId;
    req.allowedBranchIds = [branchId];
    req.selectedBranchName = access.find(
      (ba) => ba.branchId === branchId,
    )?.branchName;

    next();
  };
};

/**
 * admin أو owner أو super_admin بس
 */
const requireAdminOrOwner = (req, res, next) => {
  if (!req.user) return unauthorized(res);

  if (!["admin", "owner", "super_admin"].includes(req.user.role)) {
    return deny(res, "Forbidden. Admin or Owner access required.");
  }

  next();
};

/**
 * تسجيل العمليات
 */
const auditLog = (actionType) => {
  return (req, res, next) => {
    res.on("finish", () => {
      const entry = {
        actionType,
        userId: req.user?.id,
        userRole: req.user?.role,
        branch: req.branchId ?? req.user?.branch_id,
        tenantId: req.user?.tenant_id,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        ipAddress: req.ip,
      };

      // كان مكتوب `${statusCode}` من غير res — ReferenceError على أي رد >= 400
      if (res.statusCode >= 400) {
        console.warn(`[AUDIT ${res.statusCode}]`, entry);
      } else {
        console.log("[AUDIT]", entry);
      }
    });

    next();
  };
};

module.exports = {
  STAFF,
  MANAGERS,
  FULL_ACCESS_ROLES,
  FEATURES_BLOCKED_BY_ROLE,
  effectiveFeatures,
  inTenantPlan,
  resolveBranchId,
  requireRole,
  requireBranchAccess,
  requireMultipleFeatures,
  requireAdminOrOwner,
  auditLog,
};
