// src/modules/reports/reports.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");

const {
  getRevenue, getProfit, getSummary, getAttendance, getTopCourses,
  getRenewals, getStudentReport, getTodayRevenue, getMonthRevenue,
} = require("./reports.controller");

// كل التقارير محتاجة login
router.use(auth);

// today و month: أي موظف (بيظهروا في الداشبورد)
router.get(
  "/today", 
  requireRole(...STAFF),
  getTodayRevenue
);
router.get(
  "/month", 
  requireRole(...STAFF),
  getMonthRevenue
);

// باقي التقارير التفصيلية: admin بس
router.use(requireRole("admin", "super_admin" , "owner"));

router.get("/revenue", getRevenue);
router.get("/profit", getProfit);
router.get("/summary", getSummary); // ← التقرير اليومي/الشهري بكل العمليات
router.get("/attendance", getAttendance);
router.get("/top-courses", getTopCourses);
router.get("/renewals", getRenewals);
router.get("/students", getStudentReport);

module.exports = router;