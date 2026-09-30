// src/modules/semesters/semesters.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getAll, create, update, remove, bulkSetActive,
  enroll, getEnrollments, removeEnrollment, moveSemester,
} = require("./semesters.controller");

const idField = z.coerce.number().int().positive();
const yearField = z.string().trim().min(1).max(20);

// "true" / "false" جايين من الـ query string كنص
const boolQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

// ── Schemas ───────────────────────────────────────────────
const semesterListSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    is_active: boolQuery,
    tenant_id: idField.optional(),
  }),
});

const createSemesterSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    names: z.array(z.string().trim().min(1).max(150)).max(50).optional(),
    year: yearField,
    branch_id: idField,
    tenant_id: idField.optional(),
  }),
});

// is_active اتشال من هنا — التفعيل بيتم بالسنة من bulk-active
const updateSemesterSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    year: yearField.optional(),
  }),
});

// تفعيل/إيقاف سنة دراسية كاملة
const bulkActiveSchema = z.object({
  body: z.object({
    year: yearField,
    is_active: z.boolean(),
    // الـ interceptor في الفلاتر بيحقنهم في كل request
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const idParam = z.object({ params: z.object({ id: idField }) });

const enrollSchema = z.object({
  body: z.object({
    student_id: idField,
    course_ids: z.array(idField).min(1).max(50),
    semester_id: idField.optional(),
    start_date: z.string().optional(),
    tenant_id: idField.optional(),
  }),
});

const moveSemesterSchema = z.object({
  body: z.object({
    student_id: idField,
    semester_id: idField,
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const enrollListSchema = z.object({
  query: z.object({
    student_id: idField.optional(),
    semester_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

router.use(auth);

// ── Semesters ─────────────────────────────────────────────
router.get(
  "/semesters",
  validate(semesterListSchema),
  requireRole(...STAFF),
  getAll
);

router.post(
  "/semesters",
  validate(createSemesterSchema),
  requireRole(...MANAGERS),
  withNotify(create, ["semesters_updated"])
);

// ⚠️ لازم قبل /semesters/:id — وإلا "bulk-active" هيتحسب id
router.put(
  "/semesters/bulk-active",
  validate(bulkActiveSchema),
  requireRole(...MANAGERS),
  withNotify(bulkSetActive, ["semesters_updated"])
);

router.put(
  "/semesters/:id",
  validate(updateSemesterSchema),
  requireRole(...MANAGERS), // ← كان admin/super_admin بس، فالأونر مكنش يقدر يعدّل
  withNotify(update, ["semesters_updated"])
);

router.delete(
  "/semesters/:id",
  validate(idParam),
  requireRole(...MANAGERS),
  withNotify(remove, ["semesters_updated"])
);

// ── Enrollments ───────────────────────────────────────────
router.get(
  "/enrollments",
  validate(enrollListSchema),
  requireRole(...STAFF),
  getEnrollments
);

router.post(
  "/enrollments",
  validate(enrollSchema),
  requireRole(...STAFF),
  withNotify(enroll, ["students_updated", "payments_updated"])
);

// ⚠️ لازم قبل /enrollments/:id
router.put(
  "/enrollments/semester",
  validate(moveSemesterSchema),
  requireRole(...STAFF),
  withNotify(moveSemester, ["students_updated"])
);

router.delete(
  "/enrollments/:id",
  validate(idParam),
  requireRole("admin", "super_admin"),
  withNotify(removeEnrollment, ["students_updated"])
);

module.exports = router;