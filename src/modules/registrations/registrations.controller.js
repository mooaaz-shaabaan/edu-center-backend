// src/modules/registrations/registrations.controller.js
//
// الطرف الداخلي — الموظف بيراجع طلبات التسجيل، والمدير بيدير
// روابط الـ QR.
const crypto = require("crypto");
const prisma = require("../../config/db");
const { generateQRCode } = require("../../utils/qrGenerator");
const { generatePortalCode } = require("../../utils/portalCode");
const { validateEgyptianPhone } = require("../../utils/phoneValidator");
const { tenantWhere, requireTenantId } = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const { notify } = require("../../core/sse");

// ── مساعدات ───────────────────────────────────────────────
const newToken = () => crypto.randomBytes(24).toString("base64url");

/// الرابط اللي بيتحط في الـ QR.
///
/// ⚠ المسار مش مثبّت في الكود: الصفحات ممكن تتحط في أي فولدر
///   جوه public، ولو المسار هنا مختلف عن الفولدر الحقيقي الـ QR
///   بيوصل لصفحة 404 ومحدش هيعرف ليه.
const PORTAL_PATH = "/" + (process.env.PORTAL_PATH || "student").replace(/^\/+|\/+$/g, "");

const linkUrl = (token) => {
  const base = (process.env.PORTAL_BASE_URL || "").replace(/\/+$/, "");
  return `${base}${PORTAL_PATH}/register.html?t=${token}`;
};

/// الموظف مسموح له بالفرع ده؟
/// (الأونر والسوبر أدمن بيعدّوا — getAllowedBranchIds بترجّع null)
const assertBranchAllowed = (req, branchId) => {
  const allowed = getAllowedBranchIds(req.user);
  if (allowed && !allowed.includes(branchId)) {
    const err = new Error("Forbidden. You don't have access to this branch.");
    err.status = 403;
    throw err;
  }
};

/// ⚠ `portal_code` فريد على مستوى النظام كله، والمولّد عشوائي —
///   يعني التصادم وارد مهما كان نادر. الطالب اللي بيتعمل من
///   الموبايل بيتخلق من غير حد واقف قدام الشاشة، فالفشل الصامت
///   هنا معناه طلب ضايع.
const reservePortalCode = async (tx, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    const code = generatePortalCode();
    const taken = await tx.student.findFirst({
      where: { portal_code: code },
      select: { id: true },
    });
    if (!taken) return code;
  }
  const err = new Error("تعذّر توليد كود للطالب. حاول تاني.");
  err.status = 500;
  throw err;
};

const shape = (r) => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  parent_phone: r.parent_phone,
  alt_phone: r.alt_phone,
  notes: r.notes,
  status: r.status,
  created_at: r.created_at,
  reviewed_at: r.reviewed_at,
  reject_reason: r.reject_reason,
  student_id: r.student_id,
  branch: r.branch ? { id: r.branch.id, name: r.branch.name } : null,
  semester: r.semester
    ? {
        id: r.semester.id,
        label: [r.semester.name, r.semester.year].filter(Boolean).join(" — "),
      }
    : null,
  reviewer: r.reviewer ? { id: r.reviewer.id, name: r.reviewer.name } : null,
  courses: (r.courses ?? [])
    .filter((c) => c.course)
    .map((c) => ({ id: c.course.id, name: c.course.name })),
});

// ── GET /api/registrations ────────────────────────────────
const list = async (req, res, next) => {
  try {
    const status = req.validated.query.status || "pending";
    const page = req.validated.query.page || 1;
    const limit = req.validated.query.limit || 20;

    const where = { ...tenantWhere(req) };
    if (status !== "all") where.status = status;

    // ── البحث ─────────────────────────────────────────────
    // ⚠ بالاسم أو أي رقم من التلاتة. الموظف بيدوّر برقم ولي الأمر
    //   كتير — الأب بيكلّم السنتر من موبايله مش موبايل ابنه.
    //   `insensitive` للأسماء اللاتينية؛ العربي مالوش حالة حروف.
    const q = (req.validated.query.q || "").trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { parent_phone: { contains: q } },
        { alt_phone: { contains: q } },
      ];
    }

    // الفرع: المحدد، وإلا كل فروع الموظف
    if (req.branchId) {
      assertBranchAllowed(req, req.branchId);
      where.branch_id = req.branchId;
    } else {
      const allowed = getAllowedBranchIds(req.user);
      if (allowed) where.branch_id = { in: allowed };
    }

    const [rows, total, pendingCount] = await Promise.all([
      prisma.studentRegistration.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          branch: { select: { id: true, name: true } },
          reviewer: { select: { id: true, name: true } },
          semester: { select: { id: true, name: true, year: true } },
          courses: { include: { course: { select: { id: true, name: true } } } },
        },
      }),
      prisma.studentRegistration.count({ where }),
      // ⚠ العدّاد للشارة في القايمة الجانبية — للمستني بس، ومن غير
      //   البحث. لو اتأثر بالبحث، الشارة كانت هتنزل لما الموظف
      //   يكتب في خانة البحث وكأن الطلبات اختفت.
      prisma.studentRegistration.count({
        where: { ...where, OR: undefined, status: "pending" },
      }),
    ]);

    res.json({
      success: true,
      data: rows.map(shape),
      pending_count: pendingCount,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── منطق الموافقة ─────────────────────────────────────────
/// بيحاول يقبل طلب واحد ويرجّع نتيجة بدل ما يرد على الـ HTTP.
///
/// ⚠ التقسيم ده عشان القبول الجماعي: الفشل في طلب حاجة عادية —
///   رقم بقى متسجّل لطالب تاني، فرع اتوقف، حد تاني راجع الطلب —
///   والدفعة لازم تكمّل على الباقي. لو الردود فضلت متبعترة جوه
///   المنطق، أول فشل كان هينهي الدفعة كلها.
const approveOne = async (req, tenantId, id) => {
  const fail = (code, message, data) => ({ ok: false, code, message, data });

  const reg = await prisma.studentRegistration.findFirst({
    where: { id, tenant_id: tenantId },
    include: { courses: { select: { course_id: true } } },
  });

  if (!reg) return fail("NOT_FOUND", "الطلب مش موجود.");

  // ⚠ مش `assertBranchAllowed` اللي بترمي — في الدفعة الرمي بيوقف
  //   الباقي. نفس الفحص بالظبط، بس كنتيجة.
  const allowedBranches = getAllowedBranchIds(req.user);
  if (allowedBranches && !allowedBranches.includes(reg.branch_id)) {
    return fail("FORBIDDEN", "الطلب ده في فرع مالكش صلاحية عليه.");
  }

  if (reg.status !== "pending") {
    return fail(
      "ALREADY_REVIEWED",
      reg.status === "approved"
        ? "اتوافق عليه قبل كده."
        : "مرفوض — الطالب لازم يبعت طلب جديد.",
    );
  }

  // ⚠ الطلب ممكن يكون قاعد أيام. ممكن الموظف يكون ضاف الطالب
  //   بإيده في الوقت ده، أو الفرع اتوقف. الفحص وقت الموافقة مش
  //   وقت الإرسال.
  if (!validateEgyptianPhone(reg.phone)) {
    return fail(
      "BAD_PHONE",
      `رقم "${reg.phone}" مش رقم مصري صحيح — عدّل الطلب الأول.`,
    );
  }

  const clash = await prisma.student.findFirst({
    where: { tenant_id: tenantId, phone: reg.phone },
    select: { id: true, name: true, is_active: true },
  });

  if (clash) {
    return fail(
      "PHONE_TAKEN",
      `الرقم بقى متسجّل للطالب "${clash.name}"${
        clash.is_active ? "" : " (موقوف)"
      }.`,
      { student_id: clash.id },
    );
  }

  const branch = await prisma.branch.findFirst({
    where: { id: reg.branch_id, tenant_id: tenantId },
    select: { id: true, name: true, is_active: true },
  });

  if (!branch?.is_active) {
    return fail(
      "BRANCH_INACTIVE",
      `فرع "${branch?.name ?? "الطلب"}" موقوف — فعّله الأول.`,
    );
  }

  const courseIds = [
    ...new Set(reg.courses.map((c) => c.course_id).filter(Boolean)),
  ];

  try {
    const student = await prisma.$transaction(async (tx) => {
      const portalCode = await reservePortalCode(tx);
      const qrCode = await generateQRCode(portalCode);

      const created = await tx.student.create({
        data: {
          tenant_id: tenantId,
          branch_id: reg.branch_id,
          name: reg.name,
          phone: reg.phone,
          parent_phone: reg.parent_phone,
          alt_phone: reg.alt_phone,
          portal_code: portalCode,
          qr_code: qrCode,
          wallet_enabled: false,
          wallet_balance: 0,
        },
        select: {
          id: true,
          name: true,
          phone: true,
          portal_code: true,
          qr_code: true,
          branch_id: true,
        },
      });

      if (courseIds.length) {
        await tx.enrollment.createMany({
          data: courseIds.map((course_id) => ({
            tenant_id: tenantId,
            student_id: created.id,
            course_id,
            // الصف اللي الطالب اختاره في الفورم
            semester_id: reg.semester_id ?? null,
            start_date: new Date(),
            status: "unpaid",
          })),
        });
      }

      await tx.studentRegistration.update({
        where: { id: reg.id },
        data: {
          status: "approved",
          student_id: created.id,
          reviewed_by: req.user.id,
          reviewed_at: new Date(),
        },
      });

      return created;
    });

    return { ok: true, student, name: reg.name };
  } catch (err) {
    // اتنين وافقوا في نفس اللحظة، أو الرقم اتسجّل بين الفحص والكتابة
    if (err.code === "P2002") {
      return fail("PHONE_TAKEN", "الرقم اتسجّل لطالب تاني في نفس اللحظة.");
    }
    throw err;
  }
};

// ── POST /api/registrations/:id/approve ───────────────────
/// بيحوّل الطلب لطالب حقيقي: كود + QR + تسجيل في المواد.
const approve = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const r = await approveOne(req, tenantId, req.validated.params.id);

    if (!r.ok) {
      const status =
        r.code === "NOT_FOUND"
          ? 404
          : r.code === "FORBIDDEN"
            ? 403
            : r.code === "ALREADY_REVIEWED" || r.code === "PHONE_TAKEN"
              ? 409
              : 400;
      return res
        .status(status)
        .json({ success: false, code: r.code, message: r.message, data: r.data });
    }

    notify("registrations_updated", {}, tenantId);
    notify("students_updated", {}, tenantId);

    res.json({
      success: true,
      message: `اتفعّل "${r.student.name}" — كوده ${r.student.portal_code}`,
      data: r.student,
    });
  } catch (err) {
    next(err);
  }
};

// ── منطق الرفض ────────────────────────────────────────────
/// نفس فكرة `approveOne` — نتيجة مش رد، عشان الرفض الجماعي.
const rejectOne = async (req, tenantId, id, reason) => {
  const fail = (code, message) => ({ ok: false, code, message });

  const reg = await prisma.studentRegistration.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true, status: true, branch_id: true, name: true },
  });

  if (!reg) return fail("NOT_FOUND", "الطلب مش موجود.");

  const allowedBranches = getAllowedBranchIds(req.user);
  if (allowedBranches && !allowedBranches.includes(reg.branch_id)) {
    return fail("FORBIDDEN", "الطلب ده في فرع مالكش صلاحية عليه.");
  }

  if (reg.status !== "pending") return fail("ALREADY_REVIEWED", "اتراجع قبل كده.");

  await prisma.studentRegistration.update({
    where: { id: reg.id },
    data: {
      status: "rejected",
      reject_reason: reason,
      reviewed_by: req.user.id,
      reviewed_at: new Date(),
    },
  });

  return { ok: true, name: reg.name };
};

// ── POST /api/registrations/:id/reject ────────────────────
const reject = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const reason = req.validated.body?.reason?.trim() || null;
    const r = await rejectOne(req, tenantId, req.validated.params.id, reason);

    if (!r.ok) {
      const status =
        r.code === "NOT_FOUND" ? 404 : r.code === "FORBIDDEN" ? 403 : 409;
      return res
        .status(status)
        .json({ success: false, code: r.code, message: r.message });
    }

    notify("registrations_updated", {}, tenantId);
    res.json({ success: true, message: `اترفض طلب "${r.name}".` });
  } catch (err) {
    next(err);
  }
};

/// «طلب واحد» / «طلبين» / «٥ طلبات» / «١٢ طلب»
const nReq = (n) =>
  n === 1 ? "طلب واحد" : n === 2 ? "طلبين" : n <= 10 ? `${n} طلبات` : `${n} طلب`;

// ── POST /api/registrations/bulk ──────────────────────────
/// قبول أو رفض مجموعة مرة واحدة — بالـ ids اللي الموظف علّم عليهم.
///
/// ⚠ بالتسلسل مش بالتوازي: كل موافقة بتحجز `portal_code` فريد
///   وبتفتح transaction. التوازي كان هيزوّد تصادم الأكواد وضغط
///   الاتصالات من غير مكسب — الدفعة بتبقى عشرين طلب مش ألف.
///
/// ⚠ ومفيش transaction واحدة حوالين الدفعة كلها عن قصد. النجاح
///   الجزئي هو الطبيعي هنا (رقم اتسجّل، فرع اتوقف)، ولفّها في
///   transaction معناه إن طلب واحد باظ يرجّع التسعتاشر التانيين.
///   اللي ينفع بيعدّي، والباقي بيترجع بسببه.
const bulk = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const { action, ids } = req.validated.body;
    const reason = req.validated.body.reason?.trim() || null;

    const unique = [...new Set(ids)];
    const done = [];
    const failed = [];

    for (const id of unique) {
      const r =
        action === "approve"
          ? await approveOne(req, tenantId, id)
          : await rejectOne(req, tenantId, id, reason);

      if (r.ok) {
        done.push({
          id,
          name: r.name,
          student_id: r.student?.id ?? null,
          portal_code: r.student?.portal_code ?? null,
        });
      } else {
        failed.push({ id, code: r.code, message: r.message });
      }
    }

    // إشعار واحد للدفعة كلها مش واحد لكل طلب
    if (done.length) {
      notify("registrations_updated", {}, tenantId);
      if (action === "approve") notify("students_updated", {}, tenantId);
    }

    const verb = action === "approve" ? "اتقبل" : "اترفض";
    const message = !failed.length
      ? `${verb} ${nReq(done.length)}.`
      : !done.length
        ? `مفيش ولا طلب ${verb} — شوف الأسباب تحت.`
        : `${verb} ${nReq(done.length)}، و${nReq(failed.length)} ماعدّاش.`;

    res.json({
      success: done.length > 0,
      message,
      data: { done, failed },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/registrations/:id/options ────────────────────
/// الصفوف والمواد المتاحة للطلب ده — بتملا شاشة التعديل.
///
/// ⚠ endpoint خاص بدل ما الواجهة تنادي الصفوف والمواد من موديولين
///   تانيين وتفلتر بإيدها. المواد لازم تبقى بتاعة **فرع الطلب**،
///   مش الفرع المختار في الشاشة — والاتنين بيختلفوا لما الموظف
///   يبص على طلبات كل فروعه. والصفوف بقت على مستوى السنتر.
const options = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const tenantId = requireTenantId(req);

    const reg = await prisma.studentRegistration.findFirst({
      where: { id, tenant_id: tenantId },
      select: { id: true, branch_id: true },
    });

    if (!reg) {
      return res
        .status(404)
        .json({ success: false, message: "الطلب مش موجود." });
    }

    assertBranchAllowed(req, reg.branch_id);

    const [semesters, rows] = await Promise.all([
      prisma.semester.findMany({
        where: { tenant_id: tenantId, is_active: true },
        select: { id: true, name: true, year: true },
        orderBy: [{ year: "desc" }, { name: "asc" }],
      }),
      prisma.courseBranch.findMany({
        where: { tenant_id: tenantId, branch_id: reg.branch_id },
        select: {
          price: true,
          course: { select: { id: true, name: true, is_active: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        semesters: semesters.map((s) => ({
          id: s.id,
          label: [s.name, s.year].filter(Boolean).join(" — "),
        })),
        courses: rows
          .filter((r) => r.course?.is_active)
          .map((r) => ({
            id: r.course.id,
            name: r.course.name,
            price: Number(r.price),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "ar")),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/registrations/:id ────────────────────────────
/// الموظف بيصلّح الطلب قبل ما يقبله — غلطة في الرقم، اسم ناقص،
/// مادة مختارة غلط.
///
/// ⚠ على المستني بس. بعد الموافقة البيانات بقت سجل طالب وتسجيلات
///   ومدفوعات — التعديل وقتها من شاشة الطالب نفسه.
const update = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const tenantId = requireTenantId(req);

    const reg = await prisma.studentRegistration.findFirst({
      where: { id, tenant_id: tenantId },
      select: {
        id: true,
        status: true,
        branch_id: true,
        phone: true,
        semester_id: true,
      },
    });

    if (!reg) {
      return res
        .status(404)
        .json({ success: false, message: "الطلب مش موجود." });
    }

    assertBranchAllowed(req, reg.branch_id);

    if (reg.status !== "pending") {
      return res.status(409).json({
        success: false,
        code: "ALREADY_REVIEWED",
        message:
          reg.status === "approved"
            ? "الطلب اتقبل خلاص — عدّل من شاشة الطالب."
            : "الطلب مرفوض — مابقاش ينفع يتعدّل.",
      });
    }

    const { name, parent_phone, alt_phone, notes, course_ids } =
      req.validated.body;
    const phone =
      req.validated.body.phone === undefined
        ? undefined
        : req.validated.body.phone.trim();
    const semesterId = req.validated.body.semester_id;

    // ── الأرقام ───────────────────────────────────────────
    for (const [val, label, code] of [
      [phone, "رقم الطالب", "BAD_PHONE"],
      [parent_phone, "رقم ولي الأمر", "BAD_PARENT_PHONE"],
    ]) {
      if (val !== undefined && !validateEgyptianPhone(val.trim())) {
        return res
          .status(400)
          .json({ success: false, code, message: `${label} مش مظبوط.` });
      }
    }
    if (alt_phone && !validateEgyptianPhone(alt_phone.trim())) {
      return res.status(400).json({
        success: false,
        code: "BAD_ALT_PHONE",
        message: "الرقم الاحتياطي مش مظبوط.",
      });
    }

    // ⚠ تغيير الرقم بيتفحص هنا مش وقت القبول. لو ساب الموظف يحط
    //   رقم طالب موجود، الطلب كان هيفضل مستني ويفشل وقت القبول
    //   من غير ما يعرف ليه.
    if (phone !== undefined && phone !== reg.phone) {
      const clash = await prisma.student.findFirst({
        where: { tenant_id: tenantId, phone },
        select: { id: true, name: true },
      });
      if (clash) {
        return res.status(409).json({
          success: false,
          code: "PHONE_TAKEN",
          message: `الرقم ده متسجّل للطالب "${clash.name}".`,
          data: { student_id: clash.id },
        });
      }

      const otherPending = await prisma.studentRegistration.findFirst({
        where: { tenant_id: tenantId, phone, status: "pending", NOT: { id } },
        select: { id: true, name: true },
      });
      if (otherPending) {
        return res.status(409).json({
          success: false,
          code: "DUPLICATE_PENDING",
          message: `فيه طلب تاني مستني بنفس الرقم باسم "${otherPending.name}".`,
          data: { registration_id: otherPending.id },
        });
      }
    }

    // ── الصف ──────────────────────────────────────────────
    // ⚠ بقى على مستوى السنتر — مفيش فلتر فرع
    if (semesterId != null) {
      const sem = await prisma.semester.findFirst({
        where: { id: semesterId, tenant_id: tenantId, is_active: true },
        select: { id: true },
      });
      if (!sem) {
        return res.status(400).json({
          success: false,
          code: "BAD_SEMESTER",
          message: "الصف ده مش موجود أو موقوف.",
        });
      }
    }

    // ── المواد ────────────────────────────────────────────
    let picked = null;
    if (course_ids !== undefined) {
      const rows = await prisma.courseBranch.findMany({
        where: { tenant_id: tenantId, branch_id: reg.branch_id },
        select: { course: { select: { id: true, is_active: true } } },
      });
      const allowed = new Set(
        rows.filter((r) => r.course?.is_active).map((r) => r.course.id),
      );
      picked = [...new Set(course_ids)].filter((cid) => allowed.has(cid));

      if (course_ids.length && !picked.length) {
        return res.status(400).json({
          success: false,
          code: "BAD_COURSES",
          message: "المواد دي مش متاحة في فرع الطلب.",
        });
      }
    }

    const ops = [
      prisma.studentRegistration.update({
        where: { id: reg.id },
        data: {
          ...(name !== undefined && {
            name: name.trim().replace(/\s+/g, " "),
          }),
          ...(phone !== undefined && { phone }),
          ...(parent_phone !== undefined && {
            parent_phone: parent_phone.trim(),
          }),
          ...(alt_phone !== undefined && {
            alt_phone: alt_phone?.trim() || null,
          }),
          ...(notes !== undefined && { notes: notes?.trim() || null }),
          ...(semesterId !== undefined && { semester_id: semesterId }),
        },
      }),
    ];

    // ⚠ مسح وإعادة إنشاء مش مقارنة: الطلب لسه مالوش أي أثر مالي،
    //   فمفيش مادة مقفولة زي اشتراكات الطالب المدفوعة
    if (picked !== null) {
      ops.push(
        prisma.studentRegistrationCourse.deleteMany({
          where: { registration_id: reg.id },
        }),
        prisma.studentRegistrationCourse.createMany({
          data: picked.map((course_id) => ({
            registration_id: reg.id,
            course_id,
          })),
          skipDuplicates: true,
        }),
      );
    }

    await prisma.$transaction(ops);

    const fresh = await prisma.studentRegistration.findUnique({
      where: { id: reg.id },
      include: {
        branch: { select: { id: true, name: true } },
        reviewer: { select: { id: true, name: true } },
        semester: { select: { id: true, name: true, year: true } },
        courses: { include: { course: { select: { id: true, name: true } } } },
      },
    });

    notify("registrations_updated", {}, tenantId);

    res.json({
      success: true,
      message: "اتحفظ التعديل.",
      data: shape(fresh),
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/registrations/link ───────────────────────────
/// رابط الـ QR بتاع الفرع. مفيش رابط = لسه ماتعملش.
const getLink = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const branchId = req.branchId;
    assertBranchAllowed(req, branchId);

    // ⚠ `@@unique([branch_id], name: "uq_reg_link_branch")` بيخلّي
    //   Prisma يطلب المفتاح باسمه في findUnique مش بالعمود. و`findFirst`
    //   هنا أوضح كمان لأنها بتفلتر بالسنتر في نفس الاستعلام بدل
    //   ما نجيب الصف ونقارن بعدين.
    const link = await prisma.registrationLink.findFirst({
      where: { branch_id: branchId, tenant_id: tenantId },
      include: { branch: { select: { id: true, name: true } } },
    });

    if (!link) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        id: link.id,
        branch: link.branch,
        url: linkUrl(link.token),
        qr_code: await generateQRCode(linkUrl(link.token)),
        is_active: link.is_active,
        uses_count: link.uses_count,
        rotated_at: link.rotated_at,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/registrations/link/rotate ───────────────────
/// بينشئ الرابط لو مش موجود، وبيغيّر التوكن لو موجود.
///
/// ⚠ التدوير بيقتل الـ QR القديم فورًا. ده المقصود: لو الرابط
///   اتسرّب بره السنتر، دي الطريقة الوحيدة لإيقافه.
const rotateLink = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const branchId = req.branchId;
    assertBranchAllowed(req, branchId);

    const branch = await prisma.branch.findFirst({
      where: { id: branchId, tenant_id: tenantId },
      select: { id: true, name: true, is_active: true },
    });

    if (!branch) {
      return res
        .status(404)
        .json({ success: false, message: "الفرع مش موجود في السنتر." });
    }
    if (!branch.is_active) {
      return res.status(400).json({
        success: false,
        message: `فرع "${branch.name}" موقوف — الرابط مش هيشتغل.`,
      });
    }

    const token = newToken();

    // ⚠ مش بنستخدم `upsert` بمفتاح `branch_id`: الاسم اللي Prisma
    //   بيطلبه للمفتاح ده بيختلف حسب إصدار الـ client (مرة
    //   `branch_id` ومرة `uq_reg_link_branch`)، والغلط بيطلع 500
    //   وقت التشغيل مش وقت الكتابة. الـ `id` شكله واحد دايمًا.
    const existing = await prisma.registrationLink.findFirst({
      where: { branch_id: branchId, tenant_id: tenantId },
      select: { id: true },
    });

    const link = existing
      ? await prisma.registrationLink.update({
          where: { id: existing.id },
          data: {
            token,
            is_active: true,
            rotated_at: new Date(),
            uses_count: 0, // عدّاد الـ IP بيتصفّر مع التدوير
          },
        })
      : await prisma.registrationLink.create({
          data: {
            tenant_id: tenantId,
            branch_id: branchId,
            token,
            created_by: req.user.id,
          },
        });

    const url = linkUrl(link.token);

    res.json({
      success: true,
      message: "اتعمل رابط جديد. الـ QR القديم بقى ميّت — اطبع الجديد.",
      data: {
        id: link.id,
        url,
        qr_code: await generateQRCode(url),
        is_active: true,
        uses_count: 0,
        rotated_at: link.rotated_at,
      },
    });
  } catch (err) {
    // مديرين اتنين ضغطوا في نفس اللحظة — الصف اتعمل مرتين
    if (err.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "حد تاني عمل رابط للفرع ده دلوقتي. حدّث الصفحة.",
      });
    }
    next(err);
  }
};

// ── PUT /api/registrations/link ───────────────────────────
/// تشغيل / إيقاف من غير تغيير التوكن
const setLinkActive = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const branchId = req.branchId;
    assertBranchAllowed(req, branchId);

    const isActive = req.validated.body.is_active;

    const link = await prisma.registrationLink.findFirst({
      where: { branch_id: branchId, tenant_id: tenantId },
      select: { id: true },
    });

    if (!link) {
      return res
        .status(404)
        .json({ success: false, message: "مفيش رابط للفرع ده." });
    }

    await prisma.registrationLink.update({
      where: { id: link.id },
      data: { is_active: isActive },
    });

    res.json({
      success: true,
      message: isActive ? "الرابط اشتغل." : "الرابط اتوقف.",
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  list,
  options,
  update,
  approve,
  reject,
  bulk,
  getLink,
  rotateLink,
  setLinkActive,
};
