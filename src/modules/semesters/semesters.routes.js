// src/modules/semesters/semesters.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const {
  getAll, create, update, remove,
  enroll, getEnrollments, removeEnrollment,
} = require("./semesters.controller");

router.use(auth);

// ── Semesters ─────────────────────────────────────────────
router.get("/semesters",           getAll);
router.post("/semesters",          role("admin"), create);
router.put("/semesters/:id",       role("admin"), update);
router.delete("/semesters/:id",    role("admin"), remove);

// ── Enrollments ───────────────────────────────────────────
router.get("/enrollments",         getEnrollments);
router.post("/enrollments",        enroll);
router.delete("/enrollments/:id",  role("admin"), removeEnrollment);

module.exports = router;
