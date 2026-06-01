// src/modules/shifts/shifts.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const {
  openShift,
  closeShift,
  getAll,
  getMine,
  getCurrent,
  getReport,
} = require("./shifts.controller");

router.use(auth);

router.post("/open",        openShift);              // Admin + Receptionist
router.post("/close",       closeShift);             // Admin + Receptionist
router.get("/current",      getCurrent);             // Admin + Receptionist
router.get("/mine",         getMine);                // Admin + Receptionist
router.get("/",             role("admin"), getAll);  // Admin فقط
router.get("/:id/report",   getReport);              // Admin + Receptionist (جلساته بس)

module.exports = router;
