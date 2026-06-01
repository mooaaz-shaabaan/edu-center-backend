// src/modules/reports/reports.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const {
  getRevenue,
  getProfit,
  getAttendance,
  getTopCourses,
  getRenewals,
  getStudentReport,
} = require("./reports.controller");

// كل الـ reports Admin فقط
router.use(auth, role("admin"));

router.get("/revenue",      getRevenue);
router.get("/profit",       getProfit);
router.get("/attendance",   getAttendance);
router.get("/top-courses",  getTopCourses);
router.get("/renewals",     getRenewals);
router.get("/students",     getStudentReport);

module.exports = router;
