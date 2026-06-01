// src/modules/auth/auth.controller.js
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../../config/db");

// ── Helper: توليد JWT ─────────────────────────────────────
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      branch_id: user.branch_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
};

// ── POST /api/auth/login ──────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    // جيب اليوزر من الـ DB
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.is_active) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    // تحقق من الـ password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const token = generateToken(user);

    res.json({
      success: true,
      message: "Login successful.",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          branch_id: user.branch_id,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/auth/me ──────────────────────────────────────
const me = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branch_id: true,
        is_active: true,
        created_at: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/logout ─────────────────────────────────
const logout = (req, res) => {
  // JWT stateless — الـ logout بيتعمل من الـ Flutter بحذف الـ Token
  res.json({ success: true, message: "Logged out successfully." });
};

module.exports = { login, me, logout };
