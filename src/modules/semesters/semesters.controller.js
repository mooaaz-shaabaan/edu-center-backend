// src/modules/semesters/semesters.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");

// Helper: الفرع لازم تابع لنفس السنتر

// ═══════════════════════════════════════════
// SEMESTERS
// ═══════════════════════════════════════════
// ملاحظة: التفعيل/الإيقاف بيتم على مستوى السنة الدراسية كلها،
// مش على مرحلة لوحدها. is_active موجود على كل صف في الداتابيز،
// بس bulkSetActive هي اللي بتحرّكه — لكل مراحل السنة مرة واحدة.

// GET /api/semesters
// ?is_active=true → السنين المفعّلة بس (اللي بتظهر في دايلوجات الطلاب)
// من غيره → الكل (شاشة إدارة المراحل)
const getAll = async (req, res, next) => {
  try {
    const { is_active } = req.validated.query;
    const where = { ...tenantWhere(req) };
    if (is_active !== undefined) where.is_active = is_active;

    const semesters = await prisma.semester.findMany({
      where,
      orderBy: { created_at: "desc" },
    });

    res.json({ success: true, data: semesters });
  } catch (err) {
    next(err);
  }
};

// POST /api/semesters
const create = async (req, res, next) => {
  try {
    const { name, names, year } = req.validated.body;
    const tenantId = requireTenantId(req);

    // ادعم الاتنين: name (واحد) أو names (array)
    let stageList = [];
    if (Array.isArray(names) && names.length > 0) {
      stageList = names;
    } else if (name) {
      stageList = [name];
    }

    if (stageList.length === 0) {
      return res.status(400).json({
        success: false,
        message: "name or names array is required.",
      });
    }

    // المرحلة الجديدة بتتولد بحالة سنتها — لو السنة موقوفة تبقى موقوفة
    const sibling = await prisma.semester.findFirst({
      where: { tenant_id: tenantId, year },
      select: { is_active: true },
    });
    const isActive = sibling ? sibling.is_active : true;

    // سجّل كل مرحلة كـ semester منفصل (في transaction — يا الكل يا لا حاجة)
    const semesters = await prisma.$transaction(
      stageList.map((stageName) =>
        prisma.semester.create({
          // ⚠ من غير `branch_id`. المرحلة بقت على مستوى السنتر
          //   (ميجريشن `20261001_semesters_tenant_level`) والعمود
          //   اتشال من الجدول — بس الكنترولر فضل بيبعته، فإضافة أي
          //   مرحلة كانت بتقع على PrismaClientValidationError.
          //
          //   والعميل لسه بيبعت `branch_id` في البودي لأن الـ
          //   ApiClient بيحقنه في كل طلب — فبنستقبله ونتجاهله.
          data: {
            tenant_id: tenantId, // ← الختم
            name: stageName,
            year,
            is_active: isActive,
          },
        }),
      ),
    );

    res.status(201).json({
      success: true,
      message: `تم إضافة ${semesters.length} مرحلة.`,
      data: semesters,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/semesters/bulk-active
// تفعيل/إيقاف سنة دراسية كاملة (كل مراحلها في كل الفروع)
// ⚠️ لازم يتعرّف في الـ routes قبل /semesters/:id
const bulkSetActive = async (req, res, next) => {
  try {
    const { year, is_active } = req.validated.body;
    const tenantId = requireTenantId(req);

    const result = await prisma.semester.updateMany({
      where: { tenant_id: tenantId, year },
      data: { is_active },
    });

    if (result.count === 0) {
      return res.status(404).json({
        success: false,
        message: "Academic year not found in this center.",
      });
    }

    res.json({
      success: true,
      message: is_active
        ? `تم تفعيل السنة الدراسية ${year}.`
        : `تم إيقاف السنة الدراسية ${year}.`,
      data: { year, count: result.count, is_active },
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/semesters/:id — تعديل اسم المرحلة أو سنتها
const update = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { name, year } = req.validated.body;

    const existing = await prisma.semester.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, existing);

    const semester = await prisma.semester.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(year !== undefined && { year }),
      },
    });

    res.json({ success: true, message: "Semester updated.", data: semester });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/semesters/:id
const remove = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const existing = await prisma.semester.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, existing);

    await prisma.semester.delete({ where: { id } });
    res.json({ success: true, message: "Semester deleted." });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// ENROLLMENTS
// ═══════════════════════════════════════════

/// بيتأكد إن المرحلة تابعة للسنتر وسنتها مفعّلة
const assertSemesterUsable = async (semesterId, tenantId) => {
  const semester = await prisma.semester.findUnique({
    where: { id: semesterId },
    select: { id: true, tenant_id: true, is_active: true, year: true },
  });
  if (!semester || semester.tenant_id !== tenantId) {
    const err = new Error("Semester not found in this center.");
    err.status = 400;
    throw err;
  }
  if (!semester.is_active) {
    const err = new Error(
      `السنة الدراسية ${semester.year} موقوفة — برجاء اختيار مرحلة للعام الدراسي الجديد.`,
    );
    err.status = 400;
    throw err;
  }
  return semester;
};

// POST /api/enrollments — تسجيل طالب في مادة أو أكتر
const enroll = async (req, res, next) => {
  try {
    const { student_id, course_ids, semester_id, start_date } =
      req.validated.body;
    const tenantId = requireTenantId(req);

    // 1) تأكد إن الطالب تابع لنفس السنتر
    const student = await prisma.student.findUnique({
      where: { id: student_id },
      select: { id: true, tenant_id: true },
    });
    if (!student || student.tenant_id !== tenantId) {
      return res
        .status(404)
        .json({ success: false, message: "Student not found." });
    }

    // 2) تأكد إن كل الكورسات تابعة لنفس السنتر
    const courses = await prisma.course.findMany({
      where: { id: { in: course_ids }, tenant_id: tenantId },
      select: { id: true },
    });
    if (courses.length !== course_ids.length) {
      return res.status(400).json({
        success: false,
        message: "One or more courses not found in this center.",
      });
    }

    // 3) السمستر (لو اتبعت): تابع لنفس السنتر وسنته مفعّلة
    //    الشاشة بتخفي الموقوف، وده الحاجز الأخير لو جه طلب من نسخة قديمة
    if (semester_id) {
      await assertSemesterUsable(semester_id, tenantId);
    }

    // سجّل الطالب في كل مادة (في transaction)
    const enrollments = await prisma.$transaction(
      course_ids.map((course_id) =>
        prisma.enrollment.create({
          data: {
            tenant_id: tenantId, // ← الختم
            student_id,
            course_id,
            semester_id: semester_id || null,
            start_date: start_date ? new Date(start_date) : new Date(),
            sync_status: "synced",
          },
          include: {
            course: { select: { id: true, name: true } },
            semester: { select: { id: true, name: true, year: true } },
          },
        }),
      ),
    );

    res.status(201).json({
      success: true,
      message: `تم تسجيل الطالب في ${enrollments.length} مادة.`,
      data: enrollments,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/enrollments/semester — نقل كل تسجيلات الطالب لمرحلة تانية
// بيتنادى من دايلوج تعديل الطالب لما يختار مرحلة للعام الجديد
// ⚠️ لازم يتعرّف في الـ routes قبل /enrollments/:id
const moveSemester = async (req, res, next) => {
  try {
    const { student_id, semester_id } = req.validated.body;
    const tenantId = requireTenantId(req);

    const student = await prisma.student.findUnique({
      where: { id: student_id },
      select: { id: true, tenant_id: true },
    });
    if (!student || student.tenant_id !== tenantId) {
      return res
        .status(404)
        .json({ success: false, message: "Student not found." });
    }

    await assertSemesterUsable(semester_id, tenantId);

    const result = await prisma.enrollment.updateMany({
      where: { student_id, tenant_id: tenantId },
      data: { semester_id },
    });

    res.json({
      success: true,
      message: `تم نقل ${result.count} تسجيل للمرحلة الجديدة.`,
      data: { count: result.count, semester_id },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/enrollments?student_id=
const getEnrollments = async (req, res, next) => {
  try {
    const { student_id, semester_id } = req.validated.query;
    const where = { ...tenantWhere(req) };
    if (student_id) where.student_id = student_id;
    if (semester_id) where.semester_id = semester_id;

    const enrollments = await prisma.enrollment.findMany({
      where,
      include: {
        student: { select: { id: true, name: true } },
        course: { select: { id: true, name: true } },
        semester: { select: { id: true, name: true, year: true } },
      },
      orderBy: { created_at: "desc" },
    });

    res.json({ success: true, data: enrollments });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/enrollments/:id
const removeEnrollment = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const existing = await prisma.enrollment.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, existing);

    await prisma.enrollment.delete({ where: { id } });
    res.json({ success: true, message: "Enrollment removed." });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  create,
  update,
  remove,
  bulkSetActive,
  enroll,
  getEnrollments,
  removeEnrollment,
  moveSemester,
};
