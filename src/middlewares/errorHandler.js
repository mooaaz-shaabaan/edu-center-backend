// src/middlewares/errorHandler.js
// Global error catcher — بيمسك أي خطأ غير متوقع ويرجع response منظم

module.exports = (err, req, res, next) => {
  console.error("❌ Error:", err.message);

  // Prisma errors
  if (err.code === "P2002") {
    return res.status(409).json({
      success: false,
      message: "Duplicate entry. This record already exists.",
      field: err.meta?.target,
    });
  }

  if (err.code === "P2025") {
    return res.status(404).json({
      success: false,
      message: "Record not found.",
    });
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      message: "Invalid token.",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      message: "Token expired. Please login again.",
    });
  }

  // Validation errors
  if (err.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  // Default
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
};
