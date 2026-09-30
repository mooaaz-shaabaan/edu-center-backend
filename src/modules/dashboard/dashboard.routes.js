// src/modules/dashboard/dashboard.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const { getDashboard } = require("./dashboard.controller");

const idField = z.coerce.number().int().positive();

const dashboardSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

router.use(auth);

// أي موظف — الكنترولر بيفلتر على فروعه المسموحة
// والمديرين بس هما اللي بيشوفوا الجلسات المفتوحة
router.get("/", validate(dashboardSchema), requireRole(...STAFF), getDashboard);

module.exports = router;
