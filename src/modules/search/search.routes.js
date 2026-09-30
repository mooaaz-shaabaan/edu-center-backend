// src/modules/search/search.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");

const { globalSearch } = require("./search.controller");

const searchSchema = z.object({
  query: z.object({
    q: z
      .string()
      .trim()
      .min(2, "Search query must be at least 2 characters.")
      .max(100),
    tenant_id: z.coerce.number().int().positive().optional(), // للـ super_admin
  }),
});

router.use(auth);

router.get("/", validate(searchSchema), requireRole(...STAFF), globalSearch);

module.exports = router;
