// src/modules/courses/courses.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const { assertBranchAccess } = require("../branches/branches.controller");

// ── Helpers ───────────────────────────────────────────────
const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

const forbidden = (message) => {
  const err = new Error(message);
  err.status = 403;
  return err;
};

/**
 * الفروع اللي اليوزر مسموح له بيها. null = كل الفروع.
 *
 * ⚠ الموديول كله كان بيفلتر بالـ tenant بس — يعني ريسبشن فرع
 *   واحد كان بيجيب كل مواد السنتر بأسعار كل الفروع من
 *   `GET /courses` من غير ما يبعت branch_id، وكان يقدر يبعت
 *   `?branch_id=<فرع تاني>` ويشوف أسعاره.
 */
const allowedBranches = (req) => getAllowedBranchIds(req.user);

/** اليوزر ليه حق على فرع واحد على الأقل من فروع المادة؟ */
const assertCourseVisible = (req, courseBranchIds) => {
  const allowed = allowedBranches(req);
  if (allowed === null) return;
  if (!courseBranchIds.some((bid) => allowed.includes(bid))) {
    throw forbidden("You don't have access to this course.");
  }
};

// كل الفروع لازم تابعة لنفس السنتر
const assertBranchesInTenant = async (branchIds, tenantId) => {
  const rows = await prisma.branch.findMany({
    where: { id: { in: branchIds }, tenant_id: tenantId },
    select: { id: true, name: true, is_active: true },
  });
  if (rows.length !== branchIds.length) {
    throw badRequest("فرع أو أكثر غير تابع لهذا السنتر.");
  }
  return rows;
};

/**
 * الفرع اللي بنضيف المادة عليه لازم يكون شغّال.
 *
 * ⚠ كان الفحص على الـ tenant بس — فكان ينفع تربط مادة بفرع موقوف
 *   وتفضل ظاهرة في شاشات الفرع ده.
 *   (الفروع المربوطة قبل كده بتعدّي عادي عشان تعديل الاسم
 *   مايتقفلش على مادة في فرع موقوف)
 */
const assertBranchesUsable = async (
  req,
  branchIds,
  tenantId,
  newIds = null,
) => {
  const rows = await assertBranchesInTenant(branchIds, tenantId);
  const mustBeActive = newIds ?? branchIds;
  const dead = rows.filter((b) => mustBeActive.includes(b.id) && !b.is_active);
  if (dead.length > 0) {
    throw badRequest(
      `الفرع "${dead[0].name}" موقوف — مينفعش تضيف المادة عليه.`,
    );
  }
  return rows;
};

// أي ميعاد متحدد له فرع، لازم الفرع ده يكون من فروع المادة
const assertSchedulesInBranches = (schedules, branchIds) => {
  if (!schedules) return;
  const invalid = schedules.some(
    (s) => s.branch_id != null && !branchIds.includes(s.branch_id),
  );
  if (invalid) {
    throw badRequest("فيه ميعاد على فرع المادة مش متاحة فيه.");
  }
};

/**
 * بيجهّز صفوف course_branches النهائية:
 *  - unified    → نفس السعر لكل الفروع
 *  - per_branch → كل فرع بسعره
 *    (في التعديل: لو فرع موجود قبل كده ومتبعتش سعره، بياخد سعره القديم)
 */
const resolvePricing = ({ mode, price, branches, existingPrices = {} }) => {
  if (!branches || branches.length === 0) {
    throw badRequest("اختار فرع واحد على الأقل للمادة.");
  }

  let rows;
  if (mode === "unified") {
    if (price === undefined || price === null) {
      throw badRequest("اكتب سعر المادة.");
    }
    rows = branches.map((b) => ({ branch_id: b.branch_id, price }));
  } else {
    rows = branches.map((b) => {
      const branchPrice = b.price ?? existingPrices[b.branch_id];
      if (branchPrice === undefined || branchPrice === null) {
        throw badRequest("اكتب سعر المادة في كل فرع.");
      }
      return { branch_id: b.branch_id, price: branchPrice };
    });
  }

  return {
    mode,
    rows,
    // ── مؤقت: أعمدة courses القديمة لسه مطلوبة لحد ما نشيلها ──
    legacyPrice: rows[0].price,
    legacyBranchId: rows[0].branch_id,
  };
};

// سعر المادة في الفرع المطلوب — عشان أي شاشة بتقرا price تفضل تعرض الصح
const withBranchPrice = (course, branchId) => {
  if (!branchId || !course.branches) return course;
  const cb = course.branches.find((b) => b.branch_id === branchId);
  return cb ? { ...course, price: cb.price } : course;
};

const toScheduleRows = (schedules, tenantId) =>
  schedules.map((s) => ({
    tenant_id: tenantId,
    branch_id: s.branch_id ?? null, // ← null = كل فروع المادة
    day_of_week: s.day_of_week,
    start_time: s.start_time,
  }));

/**
 * الـ include بقى دالة عشان يفلتر الفروع والمواعيد على فروع اليوزر.
 *
 * ⚠ من غير الفلترة دي الريسبونس نفسه بيسرّب أسعار الفروع التانية
 *   حتى لو الصف اتفلتر صح.
 *   (الميعاد اللي branch_id = null معناه "كل فروع المادة" — بيفضل ظاهر)
 */
const courseInclude = (allowed) => ({
  branch: { select: { id: true, name: true } }, // ← مؤقت (للشاشات القديمة)
  branches: {
    where: allowed ? { branch_id: { in: allowed } } : undefined,
    select: {
      branch_id: true,
      price: true,
      branch: { select: { id: true, name: true } },
    },
    orderBy: { branch_id: "asc" },
  },
  course_schedules: {
    where: allowed
      ? { OR: [{ branch_id: null }, { branch_id: { in: allowed } }] }
      : undefined,
    select: { id: true, branch_id: true, day_of_week: true, start_time: true },
    orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }],
  },
  _count: { select: { enrollments: true } }, // ← عدد الطلاب المسجّلين
});

// ── GET /api/courses ──────────────────────────────────────
const getCourses = async (req, res, next) => {
  try {
    const { branch_id, is_active } = req.validated.query;
    const allowed = allowedBranches(req);

    // ⚠ كان `is_active: true` ثابت — المادة الموقوفة كانت بتختفي
    //   من الشاشة ومفيش طريقة ترجّعها. الديفولت لسه الشغّالة بس
    //   عشان شاشات الحضور والتسجيل ماتتأثرش.
    const where = {
      ...tenantWhere(req),
      is_active: is_active === undefined ? true : is_active,
    };

    if (branch_id) {
      assertBranchAccess(req, branch_id); // ← 403 لو مش من فروعه
      where.branches = { some: { branch_id } };
    } else if (allowed !== null) {
      where.branches = { some: { branch_id: { in: allowed } } };
    }

    const courses = await prisma.course.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: courseInclude(allowed),
    });

    // من غير branch_id، لو اليوزر على فرع واحد بس — اعرض سعره
    const priceBranch =
      branch_id ?? (allowed && allowed.length === 1 ? allowed[0] : null);

    res.json({
      success: true,
      data: courses.map((c) => withBranchPrice(c, priceBranch)),
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/courses ─────────────────────────────────────
const createCourse = async (req, res, next) => {
  try {
    const {
      name,
      description,
      price_mode,
      price,
      branches,
      branch_id,
      grace_minutes,
      schedules,
    } = req.validated.body;
    const tenantId = requireTenantId(req);

    // ← مؤقت: الشاشة القديمة بتبعت branch_id بس من غير branches
    const branchList = branches ?? (branch_id ? [{ branch_id }] : []);

    const pricing = resolvePricing({
      mode: price_mode,
      price,
      branches: branchList,
    });
    const branchIds = pricing.rows.map((r) => r.branch_id);

    // ⚠ كان بيفحص الـ tenant بس — الأدمن المقيّد بفرع كان يقدر
    //   ينشئ مادة على فرع مش بتاعه ويحدد سعرها
    branchIds.forEach((bid) => assertBranchAccess(req, bid));
    await assertBranchesUsable(req, branchIds, tenantId);
    assertSchedulesInBranches(schedules, branchIds);

    const course = await prisma.course.create({
      data: {
        tenant_id: tenantId,
        name,
        description: description || null,
        price_mode: pricing.mode,
        grace_minutes: grace_minutes ?? 15, // ← لو مبعتش يبقى 15
        // ── مؤقت ──
        price: pricing.legacyPrice,
        branch_id: pricing.legacyBranchId,
        // ← الفروع + سعر كل فرع
        branches: {
          create: pricing.rows.map((r) => ({
            tenant_id: tenantId,
            branch_id: r.branch_id,
            price: r.price,
          })),
        },
        course_schedules:
          schedules && schedules.length > 0
            ? { create: toScheduleRows(schedules, tenantId) }
            : undefined,
      },
      include: courseInclude(null),
    });

    res
      .status(201)
      .json({ success: true, message: "Course created.", data: course });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/courses/:id ──────────────────────────────────
const updateCourse = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const {
      name,
      description,
      is_active,
      grace_minutes,
      schedules,
      price_mode,
      price,
      branches,
    } = req.validated.body;

    const existing = await prisma.course.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        price: true,
        price_mode: true,
        branches: { select: { branch_id: true, price: true } },
      },
    });
    assertSameTenant(req, existing);
    const tenantId = existing.tenant_id;

    const existingBranchIds = existing.branches.map((b) => b.branch_id);
    assertCourseVisible(req, existingBranchIds); // ← 403 لو المادة مش في فروعه

    const existingPrices = Object.fromEntries(
      existing.branches.map((b) => [b.branch_id, b.price]),
    );

    // ── الفروع والأسعار: بتتحسب بس لو اتبعت أي حاجة منهم ──
    let pricing = null;
    if (
      price_mode !== undefined ||
      price !== undefined ||
      branches !== undefined
    ) {
      const mode = price_mode ?? existing.price_mode;

      // ⚠ التحويل من "سعر لكل فرع" لـ "سعر موحّد" من غير ما تبعت سعر
      //   كان بياخد عمود price القديم (سعر أول فرع) ويكتبه على كل
      //   الفروع من غير ما حد ياخد باله. بقى لازم سعر صريح.
      const switchingToUnified =
        mode === "unified" && existing.price_mode !== "unified";
      if (switchingToUnified && (price === undefined || price === null)) {
        throw badRequest("اكتب السعر الموحّد للمادة قبل ما تحوّلها لسعر واحد.");
      }

      pricing = resolvePricing({
        mode,
        price: mode === "unified" ? (price ?? existing.price) : price,
        branches:
          branches ??
          existing.branches.map((b) => ({ branch_id: b.branch_id })),
        existingPrices,
      });
    }

    const finalBranchIds = pricing
      ? pricing.rows.map((r) => r.branch_id)
      : existingBranchIds;

    const removed = existingBranchIds.filter(
      (bid) => !finalBranchIds.includes(bid),
    );
    const added = finalBranchIds.filter(
      (bid) => !existingBranchIds.includes(bid),
    );

    if (pricing) {
      await assertBranchesUsable(req, finalBranchIds, tenantId, added);

      // ⚠ الصلاحية بتتفحص على الفروع اللي اتغيّرت بس (إضافة · حذف ·
      //   تغيير سعر) — كده الأدمن المقيّد بفرع لسه يقدر يعدّل اسم
      //   مادة مشتركة، بس مايقدرش يلعب في سعر فرع مش بتاعه.
      const touched = new Set([...added, ...removed]);
      for (const r of pricing.rows) {
        const before = existingPrices[r.branch_id];
        if (before === undefined || Number(before) !== Number(r.price)) {
          touched.add(r.branch_id);
        }
      }
      touched.forEach((bid) => assertBranchAccess(req, bid));
    }

    if (schedules !== undefined) {
      assertSchedulesInBranches(schedules, finalBranchIds);
    }

    // ← كله في transaction: يا يتحفظ كله يا ولا حاجة
    const course = await prisma.$transaction(async (tx) => {
      if (pricing) {
        // الفروع اللي اتشالت من المادة + مواعيدها في الفروع دي
        if (removed.length > 0) {
          await tx.courseBranch.deleteMany({
            where: { course_id: id, branch_id: { in: removed } },
          });
          await tx.courseSchedule.deleteMany({
            where: { course_id: id, branch_id: { in: removed } },
          });
        }

        for (const r of pricing.rows) {
          await tx.courseBranch.upsert({
            where: {
              uq_course_branch: { course_id: id, branch_id: r.branch_id },
            },
            update: { price: r.price },
            create: {
              tenant_id: tenantId,
              course_id: id,
              branch_id: r.branch_id,
              price: r.price,
            },
          });
        }
      }

      // لو بعت schedules → امسح القديمة واعمل الجديدة
      if (schedules !== undefined) {
        await tx.courseSchedule.deleteMany({ where: { course_id: id } });
      }

      return tx.course.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(is_active !== undefined && { is_active }),
          ...(grace_minutes !== undefined && { grace_minutes }),
          ...(pricing && {
            price_mode: pricing.mode,
            // ── مؤقت ──
            price: pricing.legacyPrice,
            branch_id: pricing.legacyBranchId,
          }),
          ...(schedules !== undefined &&
            schedules.length > 0 && {
              course_schedules: {
                create: toScheduleRows(schedules, tenantId),
              },
            }),
        },
        include: courseInclude(allowedBranches(req)),
      });
    });

    res.json({ success: true, message: "Course updated.", data: course });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/courses/:id ───────────────────────────────

/** عدّاد آمن — الموديل اللي مش في الـ schema بيرجّع 0 بدل TypeError */
const safeCount = (model, where) =>
  prisma[model]?.count ? prisma[model].count({ where }) : Promise.resolve(0);

const deleteCourse = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const existing = await prisma.course.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        branches: { select: { branch_id: true } },
      },
    });
    assertSameTenant(req, existing);

    // الحذف بيشيل المادة من كل فروعها — فلازم صلاحية على كلها
    const allowed = allowedBranches(req);
    if (allowed !== null) {
      const outside = existing.branches
        .map((b) => b.branch_id)
        .filter((bid) => !allowed.includes(bid));
      if (outside.length > 0) {
        return res.status(403).json({
          success: false,
          message: "المادة متاحة في فرع مش من فروعك — مينفعش تحذفها.",
        });
      }
    }

    // ⚠ كان بيفحص التسجيلات بس. الحضور والدفعات مربوطين بالمادة
    //   كمان، فالمادة اللي فيها حضور من غير تسجيلات كانت بتقع
    //   على FK error بـ 500.
    const [enrollmentsCount, attendanceCount, paymentsCount] =
      await Promise.all([
        prisma.enrollment.count({
          where: { course_id: id, student_id: { not: null } },
        }),
        safeCount("attendance", { course_id: id }),
        safeCount("payment", { course_id: id }),
      ]);

    if (enrollmentsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `لا يمكن حذف الكورس — يوجد ${enrollmentsCount} طالب مسجل فيه.`,
      });
    }

    if (attendanceCount > 0) {
      return res.status(400).json({
        success: false,
        message: `لا يمكن حذف الكورس — فيه ${attendanceCount} سجل حضور. وقّف الكورس بدل ما تحذفه.`,
      });
    }

    if (paymentsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `لا يمكن حذف الكورس — فيه ${paymentsCount} عملية دفع مرتبطة بيه. وقّف الكورس بدل ما تحذفه.`,
      });
    }

    // المواعيد والفروع بتتمسح تلقائياً (onDelete: Cascade)
    await prisma.course.delete({ where: { id } });
    res.json({ success: true, message: "Course deleted." });
  } catch (err) {
    if (err?.code === "P2003") {
      return res.status(400).json({
        success: false,
        message:
          "لا يمكن حذف الكورس — لسه فيه بيانات مربوطة بيه. وقّف الكورس بدل ما تحذفه.",
      });
    }
    next(err);
  }
};

// ── GET /api/courses/:id/stats ────────────────────────────
const getCourseStats = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const tenantId = requireTenantId(req);
    const allowed = allowedBranches(req);

    // تأكد إن المادة تابعة لنفس السنتر
    const course = await prisma.course.findUnique({
      where: { id },
      select: {
        id: true,
        tenant_id: true,
        name: true,
        branches: { select: { branch_id: true } },
      },
    });
    if (!course || course.tenant_id !== tenantId) {
      return res.status(404).json({
        success: false,
        message: "Course not found in this center.",
      });
    }

    // ⚠ الراوت ده بيرجّع اسم الطالب وتليفونه و portal_code —
    //   وكان مفتوح لأي ريسبشن على أي مادة في السنتر، ومن غير أي
    //   تقييد بالفرع. دلوقتي لازم صلاحية على فرع من فروع المادة،
    //   والأرقام كلها متقيّدة بفروعه هو.
    assertCourseVisible(
      req,
      course.branches.map((b) => b.branch_id),
    );

    const branchScope = allowed ? { branch_id: { in: allowed } } : {};
    const studentScope = allowed
      ? { student: { branch_id: { in: allowed } } }
      : {};

    // ── الطلاب المسجّلين في المادة ─────────────────────────
    const enrollments = await prisma.enrollment.findMany({
      where: {
        course_id: id,
        tenant_id: tenantId,
        student_id: { not: null }, // ← كان بيرجّع صفوف فاضية للتسجيلات بدون طالب
        ...studentScope,
      },
      include: {
        student: {
          select: { id: true, name: true, phone: true, portal_code: true },
        },
      },
    });

    const studentIds = [
      ...new Set(enrollments.map((e) => e.student_id).filter(Boolean)),
    ];

    // ── إحصائيات الحضور للمادة (كل السجلات، مش مفلترة بأيام) ─
    const attendanceWhere = {
      course_id: id,
      tenant_id: tenantId,
      ...branchScope,
    };

    const attendanceRecords = await prisma.attendance.groupBy({
      by: ["status"],
      where: attendanceWhere,
      _count: { status: true },
    });

    const present =
      attendanceRecords.find((r) => r.status === "present")?._count.status || 0;
    const late =
      attendanceRecords.find((r) => r.status === "late")?._count.status || 0;
    const absent =
      attendanceRecords.find((r) => r.status === "absent")?._count.status || 0;
    const totalAttendance = present + late + absent;

    // ── حضور كل طالب على حدة (لعرضهم في قائمة) ─────────────
    const perStudentAttendance = await prisma.attendance.groupBy({
      by: ["student_id", "status"],
      where: attendanceWhere,
      _count: { status: true },
    });

    const studentStatsMap = {};
    for (const row of perStudentAttendance) {
      if (!row.student_id) continue;
      if (!studentStatsMap[row.student_id]) {
        studentStatsMap[row.student_id] = { present: 0, late: 0, absent: 0 };
      }
      studentStatsMap[row.student_id][row.status] = row._count.status;
    }

    const students = enrollments.map((e) => ({
      id: e.student?.id,
      name: e.student?.name,
      phone: e.student?.phone,
      portal_code: e.student?.portal_code,
      present: studentStatsMap[e.student_id]?.present || 0,
      late: studentStatsMap[e.student_id]?.late || 0,
      absent: studentStatsMap[e.student_id]?.absent || 0,
    }));

    res.json({
      success: true,
      data: {
        course_id: id,
        course_name: course.name,
        total_students: studentIds.length,
        attendance_summary: {
          present,
          late,
          absent,
          total: totalAttendance,
          present_percentage:
            totalAttendance > 0
              ? ((present / totalAttendance) * 100).toFixed(1)
              : "0",
        },
        students,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  getCourseStats,
};
