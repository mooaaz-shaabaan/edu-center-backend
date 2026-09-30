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

/// الفروع المسموحة للطلب الحالي.
///
/// ⚠ مسارات الطلبات بتعدّي على requireBranchAccess("registrations")
///   وده بيحسب الفروع **حسب الفيتشر** ويسيبها في allowedBranchIds.
///   مسارات الروابط بتعدّي على requireRole بس فمالهاش القيمة دي —
///   بترجع لفروع اليوزر كلها. الفرق ده مقصود، وتوحيدهم بيفتح
///   الروابط لأي أدمن.

const allowedBranches = (req) =>
  req.allowedBranchIds !== undefined
    ? req.allowedBranchIds
    : getAllowedBranchIds(req.user);

/// الموظف مسموح له بالفرع ده؟ (null = كل الفروع)
const assertBranchAllowed = (req, branchId) => {
  const allowed = allowedBranches(req);
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

    // الفرع: المحدد، وإلا كل فروع الموظف
    if (req.branchId) {
      assertBranchAllowed(req, req.branchId);
      where.branch_id = req.branchId;
    } else {
      const allowed = allowedBranches(req);
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
      // العدّاد للشارة في القايمة الجانبية — دايماً للمستني بس
      prisma.studentRegistration.count({
        where: { ...where, status: "pending" },
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

// ── POST /api/registrations/:id/approve ───────────────────
/// بيحوّل الطلب لطالب حقيقي: كود + QR + تسجيل في المواد.
const approve = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const tenantId = requireTenantId(req);

    const reg = await prisma.studentRegistration.findFirst({
      where: { id, tenant_id: tenantId },
      include: { courses: { select: { course_id: true } } },
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
            ? "الطلب ده اتوافق عليه قبل كده."
            : "الطلب ده مرفوض. لو عايز تقبله، الطالب يبعت طلب جديد.",
      });
    }

    // ⚠ الطلب ممكن يكون قاعد أيام. ممكن الموظف يكون ضاف الطالب
    //   بإيده في الوقت ده، أو الفرع اتوقف. الفحص وقت الموافقة مش
    //   وقت الإرسال.
    if (!validateEgyptianPhone(reg.phone)) {
      return res.status(400).json({
        success: false,
        code: "BAD_PHONE",
        message: `رقم "${reg.phone}" مش رقم مصري صحيح — عدّله مع الطالب وسجّله يدوي.`,
      });
    }

    const clash = await prisma.student.findFirst({
      where: { tenant_id: tenantId, phone: reg.phone },
      select: { id: true, name: true, is_active: true },
    });

    if (clash) {
      return res.status(409).json({
        success: false,
        code: "PHONE_TAKEN",
        message: `الرقم ده بقى متسجّل للطالب "${clash.name}"${
          clash.is_active ? "" : " (موقوف)"
        }. ارفض الطلب أو غيّر رقم الطالب.`,
        data: { student_id: clash.id },
      });
    }

    const branch = await prisma.branch.findFirst({
      where: { id: reg.branch_id, tenant_id: tenantId },
      select: { id: true, name: true, is_active: true },
    });

    if (!branch?.is_active) {
      return res.status(400).json({
        success: false,
        code: "BRANCH_INACTIVE",
        message: `فرع "${branch?.name ?? "الطلب"}" موقوف — فعّله الأول.`,
      });
    }

    const courseIds = [
      ...new Set(reg.courses.map((c) => c.course_id).filter(Boolean)),
    ];

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

    notify("registrations_updated", {}, tenantId);
    notify("students_updated", {}, tenantId);

    res.json({
      success: true,
      message: `اتفعّل "${student.name}" — كوده ${student.portal_code}`,
      data: student,
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        success: false,
        code: "PHONE_TAKEN",
        message: "الرقم ده اتسجّل لطالب تاني في نفس اللحظة. حدّث الصفحة.",
      });
    }
    next(err);
  }
};

// ── POST /api/registrations/:id/reject ────────────────────
const reject = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const tenantId = requireTenantId(req);
    const reason = req.validated.body?.reason?.trim() || null;

    const reg = await prisma.studentRegistration.findFirst({
      where: { id, tenant_id: tenantId },
      select: { id: true, status: true, branch_id: true, name: true },
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
        message: "الطلب ده اتراجع قبل كده.",
      });
    }

    await prisma.studentRegistration.update({
      where: { id: reg.id },
      data: {
        status: "rejected",
        reject_reason: reason,
        reviewed_by: req.user.id,
        reviewed_at: new Date(),
      },
    });

    notify("registrations_updated", {}, tenantId);

    res.json({ success: true, message: `اترفض طلب "${reg.name}".` });
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

module.exports = { list, approve, reject, getLink, rotateLink, setLinkActive };