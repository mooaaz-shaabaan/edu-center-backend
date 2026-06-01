// src/middlewares/role.js
// بيمنع الـ Receptionist من الوصول لـ routes الـ Admin

module.exports = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Please login first.",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden. You don't have permission to access this resource.",
      });
    }

    next();
  };
};
