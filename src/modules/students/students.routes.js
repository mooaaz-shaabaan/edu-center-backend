// src/modules/students/students.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const { getAll, getOne, create, update, remove, getQR, chargeWallet } = require("./students.controller");

// كل الـ routes محتاجة login
router.use(auth);

router.get("/",          getAll);           // Admin + Receptionist
router.get("/:id",       getOne);           // Admin + Receptionist
router.get("/:id/qr",    getQR);            // Admin + Receptionist
router.post("/",         create);           // Admin + Receptionist
router.put("/:id",       update);           // Admin + Receptionist
router.delete("/:id",    role("admin"), remove); // Admin فقط
router.post("/:id/wallet/charge", chargeWallet); // Admin + Receptionist


module.exports = router;
