// src/modules/branches/branches.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const {
  getBranches, createBranch, updateBranch, getBranchStats,
  getCourses, createCourse, updateCourse, deleteCourse,
  getRooms, createRoom, updateRoom,
} = require("./branches.controller");

router.use(auth);

// ── Branches ──────────────────────────────────────────────
router.get("/branches",              getBranches);
router.post("/branches",             role("admin"), createBranch);
router.put("/branches/:id",          role("admin"), updateBranch);
router.get("/branches/:id/stats",    getBranchStats);

// ── Rooms ─────────────────────────────────────────────────
router.get("/rooms",                 getRooms);
router.post("/rooms",                role("admin"), createRoom);
router.put("/rooms/:id",             role("admin"), updateRoom);

module.exports = router;
