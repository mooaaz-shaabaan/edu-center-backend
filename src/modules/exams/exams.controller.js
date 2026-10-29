// src/modules/exams/exams.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");

const num = (v) => (v == null ? null : Number(v));

// ── نطاق الفروع ───────────────────────────────────────────
/// ⚠ الموديول كله كان بيفلتر بالسنتر بس — موظف فرع كان بيشوف
///   امتحانات الفرع التاني. دي الفلترة اللي كانت ناقصة.
/// الفروع اللي ليه فيها **امتحانات**.
///
/// ⚠ `req.allowedBranchIds` جاية من `requireBranchAccess("exams")`،
///   فهي أضيق من فروع اليوزر: موظف واخد الامتحانات على فرع واحد
///   بس مايشوفش امتحانات فرعه التاني. (null = كل الفروع — أونر)
const examBranches = (req) =>
  req.allowedBranchIds !== undefined
    ? req.allowedBranchIds
    : getAllowedBranchIds(req.user);

const branchScope = (req) => {
  const allowed = examBranches(req);
  if (!allowed) return {};
  // امتحان من غير فرع (داتا قديمة) يفضل ظاهر للكل بدل ما يختفي
  return { OR: [{ branch_id: { in: allowed } }, { branch_id: null }] };
};

const assertBranchAccess = (req, branchId) => {
  if (branchId == null) return;
  const allowed = examBranches(req);
  if (!allowed || allowed.includes(branchId)) return;
  const err = new Error("You don't have access to this branch.");
  err.status = 403;
  throw err;
};

/// المادة تابعة لنفس السنتر — وبترجّع فرعها عشان نختم بيه الامتحان
const resolveCourse = async (courseId, tenantId) => {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, tenant_id: true, branch_id: true, name: true },
  });
  if (!course || course.tenant_id !== tenantId) {
    const err = new Error("Course not found in this center.");
    err.status = 400;
    throw err;
  }
  return course;
};

// ── إحصائيات امتحان ───────────────────────────────────────
/// الغايب بيتشال من المتوسط، مابيتحسبش صفر.
/// لو حسبناه صفر، امتحان حضره ٥ من ٢٠ متوسطه بيطلع ٢٠٪
/// وكإن الطلبة فشلوا، مع إن اللي حضروا ممكن يكونوا جابوا الدرجة كاملة.
const buildStats = (grades, totalMarks, passMarks) => {
  const scored = grades
    .filter((g) => g.status === "graded" && g.grade != null)
    .map((g) => Number(g.grade));

  const absent = grades.filter((g) => g.status === "absent").length;
  const excused = grades.filter((g) => g.status === "excused").length;
  const pending = grades.filter(
    (g) => g.status === "graded" && g.grade == null,
  ).length;

  if (scored.length === 0) {
    return {
      total_marks: num(totalMarks),
      pass_marks: num(passMarks),
      graded: 0,
      pending,
      absent,
      excused,
      average: null,
      average_percentage: null,
      highest: null,
      lowest: null,
      passed: null,
      failed: null,
      pass_rate: null,
    };
  }

  const sum = scored.reduce((a, b) => a + b, 0);
  const average = sum / scored.length;
  const max = num(totalMarks) || 0;

  let passed = null;
  let failed = null;
  let passRate = null;
  if (passMarks != null) {
    const pm = Number(passMarks);
    passed = scored.filter((s) => s >= pm).length;
    failed = scored.length - passed;
    passRate = (passed / scored.length) * 100;
  }

  return {
    total_marks: max,
    pass_marks: num(passMarks),
    graded: scored.length,
    pending,
    absent,
    excused,
    average: Math.round(average * 100) / 100,
    average_percentage:
      max > 0 ? Math.round((average / max) * 10000) / 100 : null,
    highest: Math.max(...scored),
    lowest: Math.min(...scored),
    passed,
    failed,
    pass_rate: passRate == null ? null : Math.round(passRate * 100) / 100,
  };
};

// ═══════════════════════════════════════════
// EXAMS
// ═══════════════════════════════════════════

// GET /api/exams
const getExams = async (req, res, next) => {
  try {
    const { course_id, type, from, to } = req.validated.query;

    const where = { ...tenantWhere(req), ...branchScope(req) };
    if (course_id) where.course_id = course_id;
    if (type) where.type = type;
    if (from || to) {
      where.exam_date = {};
      if (from) where.exam_date.gte = from;
      if (to) where.exam_date.lte = to;
    }

    const exams = await prisma.exam.findMany({
      where,
      orderBy: { exam_date: "desc" },
      include: {
        course: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        _count: { select: { grades: true } },
      },
    });

    res.json({
      success: true,
      data: exams.map((e) => ({
        ...e,
        total_marks: num(e.total_marks),
        pass_marks: num(e.pass_marks),
      })),
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/exams/:id
const getExam = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        course: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        grades: {
          include: {
            student: { select: { id: true, name: true, portal_code: true } },
          },
          // ⚠ كان orderBy id — الشيت كان بيطلع بترتيب الإدخال.
          //   الترتيب بالاسم هو اللي الموظف بيدوّر بيه.
          orderBy: { student: { name: "asc" } },
        },
      },
    });

    assertSameTenant(req, exam);
    assertBranchAccess(req, exam.branch_id);

    res.json({
      success: true,
      data: {
        ...exam,
        total_marks: num(exam.total_marks),
        pass_marks: num(exam.pass_marks),
        grades: exam.grades.map((g) => ({ ...g, grade: num(g.grade) })),
        stats: buildStats(exam.grades, exam.total_marks, exam.pass_marks),
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/exams/:id/sheet
/// شيت الدرجات جاهز: كل المسجّلين في المادة + درجته الحالية لو موجودة.
///
/// من غير الـ endpoint دي الفرونت كان لازم يجيب المسجّلين من موديول
/// تاني ويدمجهم مع الدرجات بإيده — والنتيجة إن طالب اتسجّل بعد
/// الامتحان مايظهرش في الشيت خالص.
const getExamSheet = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const exam = await prisma.exam.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        branch_id: true,
        course_id: true,
        title: true,
        total_marks: true,
        pass_marks: true,
        exam_date: true,
        course: { select: { id: true, name: true } },
      },
    });

    assertSameTenant(req, exam);
    assertBranchAccess(req, exam.branch_id);

    if (!exam.course_id) {
      return res.status(400).json({
        success: false,
        message: "الامتحان مش مربوط بمادة — مفيش قايمة طلاب.",
      });
    }

    const [enrollments, grades] = await Promise.all([
      prisma.enrollment.findMany({
        where: {
          tenant_id: exam.tenant_id,
          course_id: exam.course_id,
          student: { is_active: true },
        },
        select: {
          student: {
            select: {
              id: true,
              name: true,
              portal_code: true,
              branch_id: true,
            },
          },
        },
      }),
      prisma.studentGrade.findMany({
        where: { exam_id: id },
        select: { student_id: true, grade: true, status: true, notes: true },
      }),
    ]);

    const gradeBy = Object.fromEntries(
      grades.filter((g) => g.student_id != null).map((g) => [g.student_id, g]),
    );

    const rows = enrollments
      .filter((e) => e.student)
      .map((e) => {
        const g = gradeBy[e.student.id];
        return {
          student_id: e.student.id,
          student_name: e.student.name,
          portal_code: e.student.portal_code,
          grade: g ? num(g.grade) : null,
          // null = الصف لسه ماتحفظش. لو اتبعت كده في الحفظ
          // من غير درجة، هيتسجّل غياب.
          status: g ? g.status : null,
          notes: g ? g.notes : null,
          saved: Boolean(g),
        };
      })
      .sort((a, b) => a.student_name.localeCompare(b.student_name, "ar"));

    res.json({
      success: true,
      data: {
        exam: {
          id: exam.id,
          title: exam.title,
          exam_date: exam.exam_date,
          course: exam.course,
          total_marks: num(exam.total_marks),
          pass_marks: num(exam.pass_marks),
        },
        rows,
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/exams
const createExam = async (req, res, next) => {
  try {
    const {
      course_id,
      title,
      type,
      exam_date,
      total_marks,
      pass_marks,
      location,
      notes,
    } = req.validated.body;

    const tenantId = requireTenantId(req);
    const course = await resolveCourse(course_id, tenantId);

    // فرع الامتحان = فرع المادة، أو الفرع المختار في الطلب
    const branchId = req.branchId ?? course.branch_id ?? null;
    assertBranchAccess(req, branchId);

    if (pass_marks != null && pass_marks > total_marks) {
      return res.status(400).json({
        success: false,
        message: "درجة النجاح أكبر من الدرجة العظمى.",
      });
    }

    const exam = await prisma.exam.create({
      data: {
        tenant_id: tenantId, // ← الختم
        course_id,
        branch_id: branchId,
        title: title.trim(),
        type: type || "monthly",
        exam_date,
        total_marks,
        pass_marks: pass_marks ?? null,
        location: location || null,
        notes: notes || null,
      },
      include: {
        course: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: "Exam created.",
      data: {
        ...exam,
        total_marks: num(exam.total_marks),
        pass_marks: num(exam.pass_marks),
      },
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/exams/:id
const updateExam = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { title, type, exam_date, total_marks, pass_marks, location, notes } =
      req.validated.body;

    const existing = await prisma.exam.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        branch_id: true,
        total_marks: true,
        pass_marks: true,
      },
    });
    assertSameTenant(req, existing);
    assertBranchAccess(req, existing.branch_id);

    const nextTotal = total_marks ?? Number(existing.total_marks);
    const nextPass =
      pass_marks !== undefined ? pass_marks : num(existing.pass_marks);

    if (nextPass != null && nextPass > nextTotal) {
      return res.status(400).json({
        success: false,
        message: "درجة النجاح أكبر من الدرجة العظمى.",
      });
    }

    // ⚠ تقليل الدرجة العظمى بعد إدخال الدرجات بيسيب درجات
    //   أكبر من العظمى في الداتابيز — والنسب بتطلع فوق ١٠٠٪
    if (total_marks !== undefined) {
      const over = await prisma.studentGrade.count({
        where: { exam_id: id, grade: { gt: total_marks } },
      });
      if (over > 0) {
        return res.status(400).json({
          success: false,
          message: `مينفعش تقلّل الدرجة العظمى — فيه ${over} طالب درجته أكبر من ${total_marks}.`,
        });
      }
    }

    const exam = await prisma.exam.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        ...(type !== undefined && { type }),
        ...(exam_date !== undefined && { exam_date }),
        ...(total_marks !== undefined && { total_marks }),
        ...(pass_marks !== undefined && { pass_marks }),
        ...(location !== undefined && { location }),
        ...(notes !== undefined && { notes }),
      },
    });

    res.json({
      success: true,
      message: "Exam updated.",
      data: {
        ...exam,
        total_marks: num(exam.total_marks),
        pass_marks: num(exam.pass_marks),
      },
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/exams/:id
const deleteExam = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const existing = await prisma.exam.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, branch_id: true },
    });
    assertSameTenant(req, existing);
    assertBranchAccess(req, existing.branch_id);

    // الـ onDelete: Cascade في السكيما بيمسح الدرجات لوحده،
    // بس سايبين المسح الصريح عشان يفضل شغال لو الـ FK اتغيّر
    await prisma.$transaction([
      prisma.studentGrade.deleteMany({ where: { exam_id: id } }),
      prisma.exam.delete({ where: { id } }),
    ]);

    res.json({ success: true, message: "Exam deleted." });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// GRADES
// ═══════════════════════════════════════════

// POST /api/exams/:id/grades
/// رفع شيت الدرجات — الصفوف اللي في الطلب بتستبدل اللي في الداتابيز.
const saveGrades = async (req, res, next) => {
  try {
    const examId = req.validated.params.id;
    const { grades, mark_missing_absent = true } = req.validated.body;
    const tenantId = requireTenantId(req);

    const exam = await prisma.exam.findUnique({
      where: { id: examId },
      select: {
        id: true,
        tenant_id: true,
        branch_id: true,
        course_id: true,
        total_marks: true,
      },
    });
    assertSameTenant(req, exam);
    assertBranchAccess(req, exam.branch_id);

    const totalMarks = Number(exam.total_marks);
    const studentIds = [...new Set(grades.map((g) => g.student_id))];

    if (studentIds.length !== grades.length) {
      return res.status(400).json({
        success: false,
        message: "فيه طالب مكرر في الشيت.",
      });
    }

    // ⚠ كان بيتأكد إن الطالب في نفس السنتر وبس.
    //   يعني ينفع تحط درجة لأي طالب في السنتر في أي امتحان،
    //   حتى لو مش مسجّل في المادة أصلاً.
    //
    // بنجيب كل المسجّلين مش اللي في الشيت بس — محتاجينهم كمان
    // عشان نعرف مين ممتحنش ونسجّله غياب.
    const enrolled = exam.course_id
      ? (
          await prisma.enrollment.findMany({
            where: {
              tenant_id: tenantId,
              course_id: exam.course_id,
              student: { is_active: true },
            },
            select: { student_id: true },
          })
        ).map((e) => e.student_id)
      : (
          await prisma.student.findMany({
            where: { id: { in: studentIds }, tenant_id: tenantId },
            select: { id: true },
          })
        ).map((s) => s.id);

    const enrolledIds = new Set(enrolled.filter((id) => id != null));
    const notEnrolled = studentIds.filter((id) => !enrolledIds.has(id));

    if (notEnrolled.length > 0) {
      return res.status(400).json({
        success: false,
        message: `فيه ${notEnrolled.length} طالب مش مسجّل في المادة دي.`,
        data: { student_ids: notEnrolled },
      });
    }

    const row = (studentId, grade, status, notes) => ({
      tenant_id: tenantId, // ← الختم
      exam_id: examId,
      student_id: studentId,
      grade,
      status,
      notes: notes || null,
    });

    // ── صفوف الشيت ────────────────────────────────────────
    // خانة الدرجة فاضية = الطالب ممتحنش = غياب.
    // (إلا لو الشيت بعت status صريح زي excused)
    const rows = [];
    for (const g of grades) {
      const status = g.status || (g.grade == null ? "absent" : "graded");
      const isAbsent = status === "absent" || status === "excused";
      const grade = isAbsent ? null : (g.grade ?? null);

      if (grade != null && (grade < 0 || grade > totalMarks)) {
        return res.status(400).json({
          success: false,
          message: `درجة خارج المدى (٠ – ${totalMarks}) للطالب رقم ${g.student_id}.`,
        });
      }

      rows.push(row(g.student_id, grade, status, g.notes));
    }

    // ── اللي مجاش في الشيت خالص ───────────────────────────
    // المسجّل في المادة ومش موجود في الطلب = ممتحنش = غياب.
    //
    // ⚠ ده بيفترض إن الفرونت بيبعت الشيت **كامل** زي ما
    //   `GET /exams/:id/sheet` رجّعه. لو بتبعت المتغيّر بس،
    //   ابعت mark_missing_absent = false وإلا الباقي كله هيبقى غياب.
    const missing = mark_missing_absent
      ? [...enrolledIds].filter((id) => !studentIds.includes(id))
      : [];

    for (const id of missing) {
      rows.push(row(id, null, "absent", null));
    }

    const touchedIds = rows.map((r) => r.student_id);

    // ⚠ كان `$transaction` بمصفوفة upsert — شيت بـ ٢٠٠ طالب =
    //   ٢٠٠ استعلام في transaction واحدة، وPrisma بيقطعها بعد
    //   ٥ ثواني. بيشتغل مع ١٠ طلاب في التست ويفشل في الشغل الحقيقي.
    //   دلوقتي استعلامين مهما كان عدد الصفوف.
    await prisma.$transaction(
      async (tx) => {
        await tx.studentGrade.deleteMany({
          where: { exam_id: examId, student_id: { in: touchedIds } },
        });
        await tx.studentGrade.createMany({ data: rows });
      },
      { timeout: 20000 },
    );

    const absentCount = rows.filter((r) => r.status === "absent").length;

    res.json({
      success: true,
      message:
        absentCount > 0
          ? `تم حفظ ${rows.length} صف — منهم ${absentCount} غياب.`
          : `تم حفظ ${rows.length} درجة.`,
      data: {
        count: rows.length,
        graded: rows.filter((r) => r.status === "graded").length,
        absent: absentCount,
        auto_absent: missing.length, // اللي مجاش في الشيت خالص
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/exams/student/:studentId
/// كشف درجات الطالب في كل الامتحانات
const getStudentGrades = async (req, res, next) => {
  try {
    const studentId = req.validated.params.studentId;
    const { course_id } = req.validated.query;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, tenant_id: true, branch_id: true },
    });
    assertSameTenant(req, student);
    assertBranchAccess(req, student.branch_id);

    const rows = await prisma.studentGrade.findMany({
      where: {
        student_id: studentId,
        ...tenantWhere(req),
        ...(course_id ? { exam: { course_id } } : {}),
      },
      include: {
        exam: {
          select: {
            id: true,
            title: true,
            type: true,
            exam_date: true,
            total_marks: true,
            pass_marks: true,
            course: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { exam: { exam_date: "desc" } },
    });

    const results = rows.map((r) => {
      const total = Number(r.exam.total_marks);
      const grade = num(r.grade);
      return {
        exam_id: r.exam.id,
        title: r.exam.title,
        type: r.exam.type,
        exam_date: r.exam.exam_date,
        course: r.exam.course,
        total_marks: total,
        pass_marks: num(r.exam.pass_marks),
        grade,
        status: r.status,
        percentage:
          grade != null && total > 0
            ? Math.round((grade / total) * 10000) / 100
            : null,
        passed:
          grade != null && r.exam.pass_marks != null
            ? grade >= Number(r.exam.pass_marks)
            : null,
        notes: r.notes,
      };
    });

    // المتوسط العام بالنسبة المئوية — عشان امتحانات بدرجات عظمى مختلفة
    // ماينفعش تتجمع كأرقام خام
    const scored = results.filter(
      (r) => r.status === "graded" && r.percentage != null,
    );
    const avg =
      scored.length > 0
        ? Math.round(
            (scored.reduce((a, r) => a + r.percentage, 0) / scored.length) *
              100,
          ) / 100
        : null;

    res.json({
      success: true,
      data: {
        student: { id: student.id, name: student.name },
        overall_percentage: avg,
        exams_count: results.length,
        graded_count: scored.length,
        absent_count: results.filter((r) => r.status === "absent").length,
        results,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getExams,
  getExam,
  getExamSheet,
  createExam,
  updateExam,
  deleteExam,
  saveGrades,
  getStudentGrades,
};
