// src/modules/auth/auth.routes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

const { login, refresh, me, logout, logoutAll } = require("./auth.controller");
const authMiddleware = require("../../middlewares/auth");
const validate = require("../../middlewares/validate");

// ── Rate Limiters ─────────────────────────────────────────
// محاولات الـ login محدودة جدًا — ضد الـ brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 5, // 5 محاولات بس
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // المحاولات الناجحة متتحسبش
  message: {
    success: false,
    message: "Too many login attempts. Try again after 15 minutes.",
  },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Validation Schemas ────────────────────────────────────
const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email("Invalid email format.").max(255),
    password: z.string().min(1, "Password is required.").max(128),
  }),
});

// ── Routes ────────────────────────────────────────────────
router.post("/login", loginLimiter, validate(loginSchema), login);
router.post("/refresh", refreshLimiter, refresh);
router.post("/logout", authMiddleware, logout);
router.post("/logout-all", authMiddleware, logoutAll);
router.get("/me", authMiddleware, me);

module.exports = router;