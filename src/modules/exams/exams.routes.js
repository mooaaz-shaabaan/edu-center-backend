// src/modules/exams/exams.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const {
  requireRole,
  requireBranchAccess,
  MANAGERS,
} = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getExams,
  getExam,
  getExamSheet,
  createExam,
  updateExam,
  deleteExam,
  saveGrades,
  getStudentGrades,
} = require("./exams.controller");

const idField = z.coerce.number().int().positive();
const marks = z.coerce.number().min(0).max(999.99);

const examType = z.enum(["weekly", "monthly", "term", "final", "other"]);
const gradeStatus = z.enum(["graded", "absent", "excused"]);

const idParam = z.object({ params: z.object({ id: idField }) });

const listSchema = z.object({
  query: z.object({
    course_id: idField.optional(),
    type: examType.optional(),
    // ⚠ كان exam_date: z.string() من غير أي فحص —
    //   new Date("اتنين") بيدّي Invalid Date وبيقع بـ 500
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    branch_id: idField.optional(), // الـ interceptor بيحقنه
    tenant_id: idField.optional(),
  }),
});

const createSchema = z.object({
  body: z.object({
    course_id: idField,
    title: z.string().trim().min(1).max(200),
    type: examType.optional(),
    exam_date: z.coerce.date(),
    total_marks: marks.refine(
      (v) => v > 0,
      "الدرجة العظمى لازم تكون أكبر من صفر",
    ),
    pass_marks: marks.nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    type: examType.optional(),
    exam_date: z.coerce.date().optional(),
    total_marks: marks.refine((v) => v > 0).optional(),
    pass_marks: marks.nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  }),
});

// شيت الدرجات: صف لكل طالب
const gradesSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    grades: z
      .array(
        z.object({
          student_id: idField,
          // فاضية = الطالب ممتحنش → بتتسجّل غياب
          grade: z.coerce.number().min(0).max(999.99).nullish(),
          status: gradeStatus.nullish(),
          notes: z.string().max(500).nullish(),
        }),
      )
      .min(1)
      .max(2000),
    /// المسجّل في المادة ومش موجود في الشيت = غياب.
    /// خلّيها false بس لو بتبعت الصفوف المتغيّرة مش الشيت كامل.
    mark_missing_absent: z.boolean().optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const studentParam = z.object({
  params: z.object({ studentId: idField }),
  query: z.object({
    course_id: idField.optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

router.use(auth);

// ⚠ `requireBranchAccess("exams")` بتعمل حاجتين في سطر واحد:
//   السنتر مشتري الخدمة؟ والموظف واخدها على الفرع ده؟
//
//   قبل كده كان `requireRole(...STAFF)` — يعني أي موظف في
//   السنتر داخل، ومكانش فيه طريقة تمنع واحد بعينه.
const canExams = requireBranchAccess("exams");

// ── قراءة ─────────────────────────────────────────────────
router.get("/", validate(listSchema), canExams, getExams);

// ⚠ الترتيب مهم: /student/:id لازم قبل /:id
//   وإلا "/student/5" هيتطابق مع "/:id" و id = "student" → 400
router.get(
  "/student/:studentId",
  validate(studentParam),
  canExams,
  getStudentGrades,
);

router.get("/:id/sheet", validate(idParam), canExams, getExamSheet);

router.get("/:id", validate(idParam), canExams, getExam);

// ── كتابة ─────────────────────────────────────────────────
// ⚠ كانت requireRole("admin", "receptionist", "super_admin") —
//   الـ owner كان متقفل برّه الموديول كله: مش قادر يعمل امتحان
//   ولا يدخل درجة. و MANAGERS كان مستورد ومش مستخدم خالص.
router.post(
  "/",
  validate(createSchema),
  canExams,
  withNotify(createExam, "exams_updated"),
);

router.put(
  "/:id",
  validate(updateSchema),
  canExams,
  withNotify(updateExam, "exams_updated"),
);

router.post(
  "/:id/grades",
  validate(gradesSchema),
  canExams,
  withNotify(saveGrades, "exams_updated"),
);

// حذف الامتحان بيمسح درجاته كلها — لازم الصلاحية **والرتبة**
router.delete(
  "/:id",
  validate(idParam),
  canExams,
  requireRole(...MANAGERS),
  withNotify(deleteExam, "exams_updated"),
);

module.exports = router;
