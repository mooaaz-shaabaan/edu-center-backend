// src/middlewares/auth.js
const jwt = require("jsonwebtoken");
const prisma = require("../config/db");
const { hasOpenSession } = require("../core/session");

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Access denied. No token provided.",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: process.env.JWT_ISSUER || "edu-center",
      audience: process.env.JWT_AUDIENCE || "edu-center-app",
    });

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        role: true,
        branch_id: true,
        tenant_id: true,
        is_active: true,
        token_version: true,
        last_seen_at: true, // ← آخر نبضة من البرنامج
        tenant: { select: { is_active: true } },
        // ← الصلاحيات من الـ DB مباشرة (مش من التوكن)
        branch_access: {
          select: {
            branch_id: true,
            features: true,
            branch: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!user || !user.is_active) {
      return res.status(401).json({
        success: false,
        message: "Account is inactive or no longer exists.",
      });
    }

    if (user.role !== "super_admin" && (!user.tenant || !user.tenant.is_active)) {
      return res.status(403).json({
        success: false,
        message: "Center account is inactive.",
      });
    }

    if (typeof decoded.tv === "number" && decoded.tv !== user.token_version) {
      return res.status(401).json({
        success: false,
        code: "SESSION_ENDED",
        message: "Session expired. Please login again.",
      });
    }

    // ← الجلسة لازم تكون مفتوحة: نبضة خلال آخر 5 دقايق
    //   (خروج / خروج إجباري / البرنامج اتقفل أو النت فصل أكتر من 5 دقايق)
    if (!hasOpenSession(user.last_seen_at)) {
      return res.status(401).json({
        success: false,
        code: "SESSION_ENDED",
        message: "Session ended. Please login again.",
      });
    }

    req.user = {
      id: user.id,
      role: user.role,
      branch_id: user.branch_id,
      tenant_id: user.tenant_id,
      tokenVersion: user.token_version, // ← للنبضة
      branchAccess: user.branch_access.map((ba) => ({
        branchId: ba.branch_id,
        branchName: ba.branch.name,
        features: ba.features
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
      })),
    };

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired. Please login again.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({ success: false, message: "Invalid token." });
  }
};
