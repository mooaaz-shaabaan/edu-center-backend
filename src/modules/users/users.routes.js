// src/modules/users/users.routes.js
const express = require("express");
const router = express.Router();
const prisma = require("../../config/db");
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const bcrypt = require("bcryptjs");

router.use(auth);
router.use(role("admin"));

// GET /api/users
router.get("/", async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { created_at: "desc" },
      select: {
        id: true, name: true, email: true,
        role: true, is_active: true, branch_id: true, created_at: true,
      },
    });
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
});

// POST /api/users
router.post("/", async (req, res, next) => {
  try {
    const { name, email, password, role: userRole, branch_id } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "name, email, and password are required." });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { name, email, password: hashed, role: userRole || "receptionist", branch_id: branch_id ? parseInt(branch_id) : null },
      select: { id: true, name: true, email: true, role: true, is_active: true, branch_id: true },
    });
    res.status(201).json({ success: true, message: "User created.", data: user });
  } catch (err) { next(err); }
});

// PUT /api/users/:id
router.put("/:id", async (req, res, next) => {
  try {
    const { name, is_active, role: userRole } = req.body;
    const user = await prisma.user.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(name && { name }),
        ...(is_active !== undefined && { is_active }),
        ...(userRole && { role: userRole }),
      },
      select: { id: true, name: true, email: true, role: true, is_active: true },
    });
    res.json({ success: true, message: "User updated.", data: user });
  } catch (err) { next(err); }
});

module.exports = router;
