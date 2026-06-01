// src/modules/auth/auth.routes.js
const express = require("express");
const router = express.Router();
const { login, me, logout } = require("./auth.controller");
const authMiddleware = require("../../middlewares/auth");

// POST /api/auth/login  — بدون حماية
router.post("/login", login);

// POST /api/auth/logout — محتاج token
router.post("/logout", authMiddleware, logout);

// GET  /api/auth/me     — محتاج token
router.get("/me", authMiddleware, me);

module.exports = router;
