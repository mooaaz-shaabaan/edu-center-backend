// src/modules/attendance/attendance.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const {
  getAll,
  recordByQR,
  recordManual,
  syncOffline,
  getSummary,
} = require("./attendance.controller");

router.use(auth);

router.get("/",         getAll);        // Admin + Receptionist
router.get("/summary",  getSummary);    // Admin + Receptionist
router.post("/qr",      recordByQR);    // Admin + Receptionist
router.post("/manual",  recordManual);  // Admin + Receptionist
router.post("/sync",    syncOffline);   // Offline Sync

module.exports = router;
