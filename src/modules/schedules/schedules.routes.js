// src/modules/schedules/schedules.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const {
  getAll, create, update, remove, getConflicts,
  getExams, createExam, updateExam, removeExam,
} = require("./schedules.controller");

router.use(auth);

// ── Schedules ─────────────────────────────────────────────
router.get("/",             getAll);                    // Admin + Receptionist
router.post("/",            role("admin"), create);     // Admin فقط
router.put("/:id",          role("admin"), update);     // Admin فقط
router.delete("/:id",       role("admin"), remove);     // Admin فقط
router.get("/conflicts",    role("admin"), getConflicts); // Admin فقط

// ── Exams ─────────────────────────────────────────────────
router.get("/exams",        getExams);                  // Admin + Receptionist
router.post("/exams",       role("admin"), createExam); // Admin فقط
router.put("/exams/:id",    role("admin"), updateExam); // Admin فقط
router.delete("/exams/:id", role("admin"), removeExam); // Admin فقط

module.exports = router;
