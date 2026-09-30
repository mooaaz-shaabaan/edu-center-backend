// src/modules/courses/courses.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  getCourseStats,
} = require("./courses.controller");

const idField = z.coerce.number().int().positive();
const money = z.coerce.number().positive().max(10000000);

/// الـ query params بتوصل نصوص دايماً — Boolean("false") = true
const boolParam = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

// ← موعد واحد: فرع (اختياري) + يوم (0-6) + ساعة "HH:MM"
const scheduleItem = z.object({
  branch_id: idField.nullable().optional(), // ← null = كل فروع المادة
  day_of_week: z.coerce.number().int().min(0).max(6),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "start_time must be HH:MM (24h)",
  }),
});

// ← فرع + سعره (السعر مطلوب في "سعر لكل فرع" بس)
const branchPriceItem = z.object({
  branch_id: idField,
  price: money.optional(),
});

const noDuplicateBranches = (items) =>
  new Set(items.map((i) => i.branch_id)).size === items.length;

const branchesField = z
  .array(branchPriceItem)
  .min(1)
  .max(50)
  .refine(noDuplicateBranches, { message: "فيه فرع متكرر." });

const priceModeField = z.enum(["unified", "per_branch"]);

const listSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    // من غيرها → الشغّالة بس (زي الأول). is_active=false → الموقوفة،
    // عشان شاشة المواد تقدر ترجّع المادة الموقوفة.
    is_active: boolParam,
    tenant_id: idField.optional(),
  }),
});

const createSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(150),
    description: z.string().max(1000).nullable().optional(),
    price_mode: priceModeField.default("unified"),
    price: money.optional(), // ← مطلوب في "سعر موحّد"
    branches: branchesField.optional(),
    branch_id: idField.optional(), // ← مؤقت: الشاشة القديمة (لو مفيش branches)
    grace_minutes: z.coerce.number().int().min(0).max(120).optional(),
    schedules: z.array(scheduleItem).max(50).optional(),
    tenant_id: idField.optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().max(1000).nullable().optional(),
    is_active: z.boolean().optional(),
    price_mode: priceModeField.optional(),
    price: money.optional(),
    branches: branchesField.optional(),
    // branch_id اتشال: الفروع بقت بتتحدد من branches
    grace_minutes: z.coerce.number().int().min(0).max(120).optional(),
    schedules: z.array(scheduleItem).max(50).optional(),
  }),
});

const idParam = z.object({
  params: z.object({ id: idField }),
});

router.use(auth);

router.get("/", validate(listSchema), requireRole(...STAFF), getCourses);

router.post(
  "/",
  validate(createSchema),
  requireRole(...STAFF),
  withNotify(createCourse, "courses_updated"),
);

router.put(
  "/:id",
  validate(updateSchema),
  requireRole(...STAFF),
  withNotify(updateCourse, "courses_updated"),
);

router.delete(
  "/:id",
  validate(idParam),
  requireRole(...MANAGERS),
  withNotify(deleteCourse, "courses_updated"),
);

router.get(
  "/:id/stats",
  validate(idParam),
  requireRole(...STAFF),
  getCourseStats,
);

module.exports = router;
