// src/middlewares/validateBranch.js
// بيتأكد إن الـ branch_id المبعوت فرع حقيقي، شغّال، وتابع لسنتر اليوزر.
const prisma = require("../config/db");
const { resolveTenantId } = require("../core/tenant");

const extractBranchId = (req) =>
  req.body?.branch_id ?? req.params?.branch_id ?? req.query?.branch_id;

module.exports = (options = {}) => {
  const { required = true } = options;

  return async (req, res, next) => {
    try {
      const raw = extractBranchId(req);

      // مفيش فرع مبعوت
      if (raw === undefined || raw === null || raw === "") {
        // "كل الفروع" — مسموح للقراءة (required = false)
        if (!required) {
          req.branchId = null; // null = كل فروع السنتر
          return next();
        }
        return res.status(400).json({
          success: false,
          message: "branch_id is required.",
        });
      }

      const branchId = Number(raw);
      if (!Number.isInteger(branchId) || branchId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid branch_id." });
      }

      // جيب الفرع
      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: { id: true, is_active: true, tenant_id: true },
      });

      if (!branch || !branch.is_active) {
        return res.status(404).json({
          success: false,
          message: "Branch not found or inactive.",
        });
      }

      // ── الأمان: تأكد إن الفرع تابع لسنتر اليوزر ──────────
      // (super_admin اللي مختار سنتر، أو يوزر عادي → لازم يطابق)
      const tenantId = resolveTenantId(req);
      if (tenantId !== null && branch.tenant_id !== tenantId) {
        // 404 مش 403 — منديش تلميح إن الفرع موجود
        return res.status(404).json({
          success: false,
          message: "Branch not found.",
        });
      }

      req.branchId = branchId;
      next();
    } catch (err) {
      next(err);
    }
  };
};