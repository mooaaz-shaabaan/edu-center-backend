// src/modules/portal/student_portal.controller.js
//
// الطرف العام — الطالب بيوصل له من موبايله من غير حساب ولا برنامج.
// كل حاجة هنا مفتوحة على الإنترنت، فكل مدخل متعامَل معاه كإنه معادي.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const prisma = require("../../config/db");
const { validateEgyptianPhone } = require("../../utils/phoneValidator");
const { notify } = require("../../core/sse");
const { generateQRCode } = require("../../utils/qrGenerator");
const { generateUniquePortalCode } = require("../../utils/portalCode");

// ── إعدادات ───────────────────────────────────────────────
/// جلسة الطالب على الموقع — قصيرة عن قصد. مفيش حاجة تستاهل
/// إن الرابط يفضل شغّال في موبايل مسروق.
const PORTAL_SESSION = "10m";
const PORTAL_AUDIENCE = "edu-center-portal";

/// أقصى عدد طلبات من نفس الـ IP على نفس الرابط من آخر تدوير
const MAX_PER_IP = 5;

// ── مساعدات ───────────────────────────────────────────────
/// `trust proxy` متظبّطة في app.js، فـ Express بيحسب `req.ip` من
/// X-Forwarded-For لوحده. قراية الهيدر بإيدنا كانت بتتخطّى الإعداد
/// ده وتثق في هيدر أي حد يقدر يزوّره.
const clientIp = (req) => (req.ip || "").trim() || null;

const normalizeName = (name) => (name || "").trim().replace(/\s+/g, " ");

const num = (v) => Number(v ?? 0);

/// ⚠ رسايل الخطأ هنا عامة عن قصد.
///   "الرابط مش موجود" و"الرابط اتوقف" و"الرابط بتاع فرع موقوف"
///   كلهم نفس الرسالة — أي حد بيجرّب توكنات عشوائية مايتعلّمش
///   منها حاجة.
const linkError = () => {
  const err = new Error(
    "الرابط ده مش شغّال. اطلب من موظف الاستقبال يوريك الكود من تاني.",
  );
  err.status = 404;
  err.code = "LINK_INVALID";
  return err;
};

const findUsableLink = async (token) => {
  if (!token || token.length < 16) throw linkError();

  const link = await prisma.registrationLink.findUnique({
    where: { token },
    include: {
      branch: { select: { id: true, name: true, is_active: true } },
      tenant: { select: { id: true, name: true, is_active: true } },
    },
  });

  if (!link) throw linkError();
  if (!link.is_active) throw linkError();
  if (link.expires_at && link.expires_at < new Date()) throw linkError();
  if (!link.branch?.is_active) throw linkError();
  if (!link.tenant?.is_active) throw linkError();

  return link;
};

/// المواد المتاحة في الفرع ده بسعرها
const branchCourses = async (tenantId, branchId) => {
  const rows = await prisma.courseBranch.findMany({
    where: { tenant_id: tenantId, branch_id: branchId },
    select: {
      price: true,
      course: { select: { id: true, name: true, is_active: true } },
    },
  });

  return rows
    .filter((r) => r.course?.is_active)
    .map((r) => ({
      id: r.course.id,
      name: r.course.name,
      price: Number(r.price),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));
};

/// الصفوف الشغّالة في السنتر — الطالب بيختار واحد منهم
///
/// ⚠ بقت على مستوى السنتر مش الفرع: نفس «أولى ثانوي ٢٠٢٥» لكل
///   الفروع، فطالب بينتقل من فرع لفرع مابيتغيّرش صفه.
const tenantSemesters = async (tenantId) => {
  const rows = await prisma.semester.findMany({
    where: { tenant_id: tenantId, is_active: true },
    select: { id: true, name: true, year: true },
    orderBy: [{ year: "desc" }, { name: "asc" }],
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    year: r.year,
    label: [r.name, r.year].filter(Boolean).join(" — "),
  }));
};

// ── قفل محاولات الدخول ────────────────────────────────────
/// ٣ محاولات غلط على نفس الكود = قفل ساعة.
///
/// ⚠ العدّ بالكود مش بالـ IP عن قصد: طلاب الفرع كلهم على واي فاي
///   واحد، فالعدّ بالعنوان كان معناه إن تلات محاولات غلط من أي حد
///   بتقفل الصفحة على الفرع كله. فيه limiter بالـ IP كمان في ملف
///   الراوتس كخط تاني ضد اللي بيمسح أكواد بسكربت.
///
/// ⚠ العدّاد في ذاكرة العملية: إعادة تشغيل السيرفر بتصفّره، ولو
///   شغّلت أكتر من عملية كل واحدة ليها نسختها. مقبول هنا — الحماية
///   الحقيقية إن الكود لوحده مايكفيش، لازم يطابق رقم موبايل الطالب.
///   لو بعدين بقى فيه أكتر من عملية، الحل جدول في الداتابيز أو Redis.
const MAX_TRIES = 3;
const LOCK_MS = 60 * 60 * 1000;

/// code → { n: عدد المحاولات الغلط, until: وقت فك القفل }
const loginTries = new Map();

/// ⚠ من غير التنضيف ده الـ Map بتكبر مع كل كود اتجرّب ومابتصغرش —
///   تسريب ذاكرة بطيء على سيرفر شغّال شهور. `unref` عشان التايمر
///   مايمنعش العملية من الخروج.
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of loginTries) if (v.until <= now) loginTries.delete(k);
  },
  10 * 60 * 1000,
).unref();

/// بيرجّع المللي ثانية الفاضلة على فك القفل — صفر يعني مش مقفول
const lockedFor = (code) => {
  const rec = loginTries.get(code);
  if (!rec) return 0;
  const left = rec.until - Date.now();
  if (left <= 0) {
    loginTries.delete(code);
    return 0;
  }
  return rec.n >= MAX_TRIES ? left : 0;
};

/// بيسجّل محاولة غلط وبيرجّع الفاضل قبل القفل
const noteFail = (code) => {
  const rec = loginTries.get(code) || { n: 0, until: 0 };
  rec.n += 1;
  rec.until = Date.now() + LOCK_MS;
  loginTries.set(code, rec);
  return Math.max(0, MAX_TRIES - rec.n);
};

// ── GET /api/portal/register/:token ───────────────────────
/// الصفحة بتنادي عليها أول ما تفتح — تعرف السنتر والفرع
/// والمواد المتاحة قبل ما تعرض الفورم.
const getRegisterForm = async (req, res, next) => {
  try {
    const link = await findUsableLink(req.params.token);
    const [courses, semesters] = await Promise.all([
      branchCourses(link.tenant_id, link.branch_id),
      tenantSemesters(link.tenant_id),
    ]);

    res.json({
      success: true,
      data: {
        center_name: link.tenant.name,
        branch_name: link.branch.name,
        courses,
        semesters,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/portal/register/:token ──────────────────────
const submitRegistration = async (req, res, next) => {
  try {
    const link = await findUsableLink(req.params.token);
    const tenantId = link.tenant_id;
    const branchId = link.branch_id;

    const { name, phone, parent_phone, alt_phone, notes, course_ids } =
      req.validated.body;
    const semesterId = req.validated.body.semester_id ?? null;

    const cleanName = normalizeName(name);
    const cleanPhone = phone.trim();
    const cleanParent = parent_phone.trim();

    if (!validateEgyptianPhone(cleanPhone)) {
      return res.status(400).json({
        success: false,
        code: "BAD_PHONE",
        message:
          "رقم الموبايل لازم يبدأ بـ 010 أو 011 أو 012 أو 015 ويكون ١١ رقم.",
      });
    }
    if (!validateEgyptianPhone(cleanParent)) {
      return res.status(400).json({
        success: false,
        code: "BAD_PARENT_PHONE",
        message: "رقم ولي الأمر مش مظبوط.",
      });
    }
    if (alt_phone && !validateEgyptianPhone(alt_phone.trim())) {
      return res.status(400).json({
        success: false,
        code: "BAD_ALT_PHONE",
        message: "الرقم الاحتياطي مش مظبوط.",
      });
    }

    // ── الطالب ده موجود خلاص؟ ─────────────────────────────
    const existingStudent = await prisma.student.findFirst({
      where: { tenant_id: tenantId, phone: cleanPhone },
      select: { id: true },
    });

    if (existingStudent) {
      return res.status(409).json({
        success: false,
        code: "ALREADY_STUDENT",
        message:
          "الرقم ده متسجّل عندنا بالفعل. لو عايز تعدّل بياناتك افتح صفحة التعديل بالكود بتاعك.",
      });
    }

    // ── بعت طلب قبل كده ولسه مستني؟ ───────────────────────
    const pending = await prisma.studentRegistration.findFirst({
      where: { tenant_id: tenantId, phone: cleanPhone, status: "pending" },
      select: { id: true, created_at: true },
    });

    if (pending) {
      return res.status(409).json({
        success: false,
        code: "ALREADY_PENDING",
        message:
          "طلبك وصلنا خلاص ولسه تحت المراجعة. لو عدّى وقت طويل كلّم موظف الاستقبال.",
      });
    }

    // ── نفس الجهاز بعت كتير؟ ──────────────────────────────
    // العدّاد بيتصفّر مع كل تدوير للرابط، فالتوقيت من `rotated_at`
    const ip = clientIp(req);
    if (ip) {
      const fromThisIp = await prisma.studentRegistration.count({
        where: {
          link_id: link.id,
          submitted_ip: ip,
          created_at: { gte: link.rotated_at },
        },
      });

      if (fromThisIp >= MAX_PER_IP) {
        return res.status(429).json({
          success: false,
          code: "TOO_MANY",
          message: "اتبعت طلبات كتير من الجهاز ده. كلّم موظف الاستقبال.",
        });
      }
    }

    // ── الفصل المختار لازم يكون فصل شغّال في نفس الفرع ─────
    // ⚠ الطالب ممكن يبعت أي رقم من الـ devtools. من غير الفحص
    //   ده ممكن يربط نفسه بفصل فرع تاني أو فصل موقوف.
    const semesters = await tenantSemesters(tenantId);

    if (semesters.length > 0 && !semesterId) {
      return res.status(400).json({
        success: false,
        code: "SEMESTER_REQUIRED",
        message: "اختار الصف الدراسي.",
      });
    }
    if (semesterId && !semesters.some((x) => x.id === semesterId)) {
      return res.status(400).json({
        success: false,
        code: "BAD_SEMESTER",
        message: "الصف اللي اخترته مش متاح في الفرع ده.",
      });
    }

    // ── المواد المختارة لازم تكون فعلاً في الفرع ده ────────
    const allowed = await branchCourses(tenantId, branchId);
    const allowedIds = new Set(allowed.map((c) => c.id));
    const picked = [...new Set(course_ids ?? [])].filter((id) =>
      allowedIds.has(id),
    );

    if ((course_ids?.length ?? 0) > 0 && picked.length === 0) {
      return res.status(400).json({
        success: false,
        code: "BAD_COURSES",
        message: "المواد اللي اخترتها مش متاحة في الفرع ده.",
      });
    }

    const registration = await prisma.$transaction(async (tx) => {
      const created = await tx.studentRegistration.create({
        data: {
          tenant_id: tenantId,
          branch_id: branchId,
          link_id: link.id,
          name: cleanName,
          phone: cleanPhone,
          parent_phone: cleanParent,
          alt_phone: alt_phone?.trim() || null,
          notes: notes?.trim() || null,
          semester_id: semesters.length > 0 ? semesterId : null,
          submitted_ip: ip,
          courses: {
            create: picked.map((course_id) => ({ course_id })),
          },
        },
        select: { id: true, name: true },
      });

      await tx.registrationLink.update({
        where: { id: link.id },
        data: { uses_count: { increment: 1 } },
      });

      return created;
    });

    // شاشة الطلبات عند الموظفين تتحدّث فورًا
    notify("registrations_updated", {}, tenantId);

    // ⚠ الرد مافيهوش أي بيانات بترجع للطالب، ومفيش endpoint يقراها
    //   بعد كده. اللي لسه متقبلش مايشوفش غير إن الطلب وصل — فمفيش
    //   طريق حد يعرف منه مين مسجّل في السنتر برقم موبايل.
    res.status(201).json({
      success: true,
      message: "تم إرسال طلبك بنجاح. هيتم الموافقة عليه في أسرع وقت.",
      data: { registration_id: registration.id },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/portal/status ───────────────────────────────
/// «لسه مستني الموافقة؟» — الطالب بيكتب رقمه ويعرف طلبه فين.
///
/// ⚠ منفصل عن `/session` عن قصد، مش فرع جوّاه:
///   • الدخول بيدّي رسالة واحدة لكل أنواع الفشل عشان مايبقاش أداة
///     تخمين أكواد، وبيقفل بعد ٣ محاولات. الطالب المعلّق مالوش كود
///     أصلاً، فلو كان بيعدّي من هناك كان هيتقفل وهو مش غلطان.
///   • والعكس: مهاجم كان هيسجّل طلب برقم، ويستخدم الفرع المتساهل ده
///     عشان يجرّب أكواد من غير ما العدّاد يقفل عليه.
///
/// ⚠ بيرجّع حالة بس — مفيش اسم ولا فرع ولا مواد ولا تاريخ. اللي
///   يخمّن رقم يعرف إن فيه طلب، وخلاص.
const registrationStatus = async (req, res, next) => {
  try {
    const phone = String(req.validated.body.phone || "").trim();

    // ⚠ من غير فلتر سنتر: الصفحة دي مفيهاش كود ولا رابط فرع، فمفيش
    //   حاجة تقول إحنا في أنهي سنتر. الرقم فريد جوه السنتر الواحد
    //   (uq_student_phone)، والتقاطع بين سنترين نادر ومابيأثرش —
    //   الرسالة مابتسمّيش السنتر أصلاً.
    const student = await prisma.student.findFirst({
      where: { phone },
      select: { id: true, is_active: true },
    });

    const approved = {
      state: "approved",
      message:
        "طلبك اتقبل وبقيت طالب عندنا. خد الكود من موظف الاستقبال وادخل بيه فوق.",
    };

    if (student) {
      return res.json({
        success: true,
        data: student.is_active
          ? approved
          : {
              state: "inactive",
              message: "حسابك موقوف دلوقتي. كلّم موظف الاستقبال.",
            },
      });
    }

    // ⚠ آخر طلب مش أول طلب: ممكن يكون اترفض وبعت تاني
    const reg = await prisma.studentRegistration.findFirst({
      where: { phone },
      orderBy: { created_at: "desc" },
      select: { status: true, reject_reason: true },
    });

    if (!reg) {
      return res.json({
        success: true,
        data: {
          state: "none",
          message:
            "مفيش طلب بالرقم ده. كلّم موظف الاستقبال عشان يديك رابط التسجيل.",
        },
      });
    }

    if (reg.status === "approved") {
      return res.json({ success: true, data: approved });
    }

    if (reg.status === "rejected") {
      return res.json({
        success: true,
        data: {
          state: "rejected",
          message: reg.reject_reason
            ? `الطلب اترفض — ${reg.reject_reason}`
            : "الطلب اترفض. كلّم موظف الاستقبال.",
        },
      });
    }

    res.json({
      success: true,
      data: {
        state: "pending",
        message: "تم إرسال طلبك بنجاح. هيتم الموافقة عليه في أسرع وقت.",
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/portal/session ──────────────────────────────
/// دخول الطالب لصفحة البروفايل: الكود + رقم موبايله.
const openPortalSession = async (req, res, next) => {
  try {
    const { portal_code, phone } = req.validated.body;
    const code = portal_code.trim();

    // ── مقفول من محاولات قبل كده؟ ─────────────────────────
    // ⚠ الفحص ده قبل أي استعلام على الداتابيز — المقفول مايشغّلش
    //   السيرفر أصلاً
    const lockLeft = lockedFor(code);
    if (lockLeft > 0) {
      return res.status(429).json({
        success: false,
        code: "LOCKED",
        message: `اتجرّب الكود ده غلط ${MAX_TRIES} مرات. جرّب بعد ${Math.ceil(
          lockLeft / 60000,
        )} دقيقة.`,
        data: { retry_after_seconds: Math.ceil(lockLeft / 1000) },
      });
    }

    const student = await prisma.student.findFirst({
      where: { portal_code: code },
      select: {
        id: true,
        name: true,
        phone: true,
        is_active: true,
        tenant_id: true,
        tenant: { select: { is_active: true } },
      },
    });

    // ⚠ رسالة واحدة للحالات كلها — كود غلط، رقم غلط، طالب موقوف.
    //   أي تفرقة بينهم بتخلّي الصفحة أداة تخمين أكواد. وعدد
    //   المحاولات الفاضلة نفس الرقم في كل الحالات، فمابيسرّبش
    //   إن الكود موجود ولا لأ.
    const fail = () => {
      const remaining = noteFail(code);

      if (remaining > 0) {
        return res.status(401).json({
          success: false,
          code: "BAD_LOGIN",
          message: `الكود أو رقم الموبايل مش مظبوط. فاضل ${remaining} ${
            remaining === 1 ? "محاولة" : "محاولات"
          }.`,
          data: { tries_left: remaining },
        });
      }

      return res.status(429).json({
        success: false,
        code: "LOCKED",
        message: `اتجرّب غلط ${MAX_TRIES} مرات. جرّب بعد ساعة.`,
        data: { retry_after_seconds: Math.ceil(LOCK_MS / 1000) },
      });
    };

    if (!student) return fail();
    if (student.phone !== phone.trim()) return fail();
    if (!student.is_active) return fail();
    if (!student.tenant?.is_active) return fail();

    // دخول صح → العدّاد يتصفّر
    loginTries.delete(code);

    const token = jwt.sign(
      { sid: student.id, tenant_id: student.tenant_id, scope: "portal" },
      process.env.JWT_SECRET,
      {
        expiresIn: PORTAL_SESSION,
        issuer: process.env.JWT_ISSUER || "edu-center",
        // ⚠ audience مختلف عن برنامج السنتر — توكن الطالب مايشتغلش
        //   على أي endpoint تاني حتى لو حد جرّبه
        audience: PORTAL_AUDIENCE,
      },
    );

    res.json({
      success: true,
      data: { token, name: student.name, expires_in_minutes: 10 },
    });
  } catch (err) {
    next(err);
  }
};

// ── middleware: توكن الطالب ───────────────────────────────
const portalAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res
      .status(401)
      .json({ success: false, code: "NO_SESSION", message: "سجّل دخول الأول." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: process.env.JWT_ISSUER || "edu-center",
      audience: PORTAL_AUDIENCE,
    });

    if (payload.scope !== "portal" || !payload.sid) throw new Error("bad scope");

    req.portal = { studentId: payload.sid, tenantId: payload.tenant_id };
    next();
  } catch (_) {
    res.status(401).json({
      success: false,
      code: "SESSION_EXPIRED",
      message: "انتهت الجلسة. ادخل بالكود تاني.",
    });
  }
};

// ── GET /api/portal/me ────────────────────────────────────
/// البروفايل الكامل: بياناته، كورساته، حضوره، امتحاناته، مدفوعاته.
const getMe = async (req, res, next) => {
  try {
    const { studentId } = req.portal;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        name: true,
        phone: true,
        parent_phone: true,
        alt_phone: true,
        portal_code: true,
        photo: true,
        created_at: true,
        is_active: true,
        branch_id: true,
        tenant_id: true,
        wallet_enabled: true,
        wallet_balance: true,
        branch: { select: { id: true, name: true } },
        tenant: { select: { name: true } },
        enrollments: {
          select: {
            id: true,
            course_id: true,
            status: true,
            semester_id: true,
            course: { select: { name: true } },
          },
        },
      },
    });

    if (!student || !student.is_active) {
      return res.status(404).json({
        success: false,
        code: "NOT_FOUND",
        message: "الحساب مش موجود.",
      });
    }

    const [courses, semesters, attendance, grades, payments, attStats] =
      await Promise.all([
        branchCourses(student.tenant_id, student.branch_id),
        tenantSemesters(student.tenant_id),

        // آخر حضور — اليوم والحصة والمادة
        prisma.attendance.findMany({
          where: { student_id: studentId },
          orderBy: [{ attendance_day: "desc" }, { session_no: "desc" }],
          take: 30,
          select: {
            attendance_day: true,
            session_no: true,
            status: true,
            course: { select: { name: true } },
          },
        }),

        // الدرجات — الدرجة العظمى من الامتحان مش من الصف
        prisma.studentGrade.findMany({
          where: { student_id: studentId },
          orderBy: { exam: { exam_date: "desc" } },
          take: 50,
          select: {
            grade: true,
            status: true,
            exam: {
              select: {
                title: true,
                type: true,
                exam_date: true,
                total_marks: true,
                pass_marks: true,
                course: { select: { name: true } },
              },
            },
          },
        }),

        prisma.payment.findMany({
          where: { student_id: studentId },
          orderBy: { paid_at: "desc" },
          take: 20,
          select: {
            amount: true,
            kind: true,
            paid_at: true,
            receipt_number: true,
            notes: true,
          },
        }),

        // إجمالي الحضور من كل التاريخ — مش من الـ ٣٠ اللي فوق
        prisma.attendance.groupBy({
          by: ["status"],
          where: { student_id: studentId },
          _count: { _all: true },
        }),
      ]);

    // فصله الحالي = فصل أي تسجيل عنده (كلهم المفروض نفس الفصل)
    const currentSemester =
      student.enrollments.find((e) => e.semester_id != null)?.semester_id ??
      null;

    const attCounts = { present: 0, late: 0, absent: 0 };
    for (const r of attStats) {
      if (Object.prototype.hasOwnProperty.call(attCounts, r.status)) {
        attCounts[r.status] = r._count._all;
      }
    }

    // ⚠ المتوسط بيتحسب من المصحَّح بس — الغايب واللي لسه ماتصححش
    //   بيتشالوا، مش بيتحسبوا صفر. حساب الغايب صفر بينزّل متوسط
    //   طالب ممتاز غاب امتحان واحد.
    const scored = grades.filter(
      (g) => g.status === "graded" && g.grade != null,
    );
    const avgPercent =
      scored.length === 0
        ? null
        : Math.round(
            (scored.reduce(
              (s, g) =>
                s + (num(g.grade) / (num(g.exam.total_marks) || 100)) * 100,
              0,
            ) /
              scored.length) *
              10,
          ) / 10;

    res.json({
      success: true,
      data: {
        // ── هو مين ────────────────────────────────────────
        name: student.name,
        phone: student.phone,
        parent_phone: student.parent_phone,
        alt_phone: student.alt_phone,
        portal_code: student.portal_code,
        // ⚠ بتتولّد دلوقتي مش مقروءة من `qr_code` المخزّن.
        //   الصورة مشتقّة بالكامل من `portal_code`، فالمخزّن
        //   نسخة تانية من نفس المعلومة وبتبقى بايتة أول ما
        //   شكل الكود يتغيّر — الطالب القديم كان هيفضل
        //   شايف كود من غير العلامة للأبد.
        qr_code: await generateQRCode(student.portal_code),
        photo: student.photo,
        joined_at: student.created_at,
        center_name: student.tenant?.name ?? null,
        branch_name: student.branch?.name ?? null,

        // ── المحفظة (للعرض بس — التعديل مرفوض، شوف updateMe) ──
        wallet_enabled: student.wallet_enabled,
        wallet_balance: num(student.wallet_balance),

        // ── الكورسات والفصل ───────────────────────────────
        semester_id: currentSemester,
        branch_semesters: semesters,
        my_course_ids: student.enrollments
          .map((e) => e.course_id)
          .filter((id) => id !== null),
        my_courses: student.enrollments
          .filter((e) => e.course_id !== null)
          .map((e) => ({
            id: e.course_id,
            name: e.course?.name ?? "—",
            status: e.status,
          })),
        // مادة عليها مدفوعات مايتشالش — الواجهة بتقفلها
        locked_course_ids: student.enrollments
          .filter((e) => e.status !== "unpaid")
          .map((e) => e.course_id)
          .filter((id) => id !== null),
        branch_courses: courses,

        // ── الحضور ────────────────────────────────────────
        // ⚠ الغياب مشتق من الحصص اللي خلصت، مش مخزّن — فبنعرض
        //   اللي حضره فعلاً بس. رقم "الغياب" هنا هيبقى صفر دايمًا
        //   وده صح: مفيش صف في الجدول للغياب.
        attendance: {
          attended: attCounts.present + attCounts.late,
          present: attCounts.present,
          late: attCounts.late,
          recent: attendance.map((a) => ({
            day: a.attendance_day,
            session_no: a.session_no,
            status: a.status,
            course_name: a.course?.name ?? null,
          })),
        },

        // ── الامتحانات ────────────────────────────────────
        exams: {
          average_percent: avgPercent,
          items: grades.map((g) => ({
            title: g.exam.title,
            type: g.exam.type,
            date: g.exam.exam_date,
            course_name: g.exam.course?.name ?? null,
            grade: g.grade == null ? null : num(g.grade),
            total: num(g.exam.total_marks),
            pass: g.exam.pass_marks == null ? null : num(g.exam.pass_marks),
            status: g.status, // graded · absent · excused
          })),
        },

        // ── المدفوعات ─────────────────────────────────────
        payments: payments.map((p) => ({
          amount: num(p.amount),
          kind: p.kind, // fee · wallet_topup · attendance · registration
          paid_at: p.paid_at,
          receipt: p.receipt_number,
          notes: p.notes,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

/// فصل الطالب الحالي من أي تسجيل عنده
const currentSemesterOf = (student) =>
  student.enrollments.find((e) => e.semester_id != null)?.semester_id ?? null;

// ── PUT /api/portal/me ────────────────────────────────────
/// الطالب يعدّل بياناته. الاسم ورقم الموبايل والمحفظة **مقفولين**:
///   • الاسم متطبوع في كشوف ودرجات — تغييره بيقطع الربط البصري
///   • رقم الموبايل هو هويته في السيستم وهو نفسه مفتاح الدخول هنا
///   • المحفظة فلوس — متتغيّرش إلا من الدرج
/// والفرع كمان مقفول: جاي من الـ QR ومربوط بحضوره ومدفوعاته.
///
/// ⚠ الـ Zod بيرمي أي مفتاح مش معرّف في السكيمة **بصمت** — يعني
///   لو الطالب بعت `wallet_balance` من الـ devtools، الطلب كان
///   بينجح وهو فاكر إنه غيّر رصيده. الرفض الصريح أوضح: بيقوله
///   إن ده مرفوض بدل ما يسيبه يجرّب تاني.
const LOCKED_FIELDS = [
  "id",
  "name",
  "phone",
  "portal_code",
  "qr_code",
  "wallet_enabled",
  "wallet_balance",
  "is_active",
  "branch_id",
  "tenant_id",
];

const updateMe = async (req, res, next) => {
  try {
    const { studentId } = req.portal;

    // ⚠ بنفحص `req.body` الخام مش `req.validated.body` — الـ Zod
    //   بيبقى شال المفاتيح دي خلاص قبل ما نوصل هنا
    const raw = req.body || {};
    const attempted = LOCKED_FIELDS.filter((k) =>
      Object.prototype.hasOwnProperty.call(raw, k),
    );

    if (attempted.length) {
      return res.status(400).json({
        success: false,
        code: "LOCKED_FIELD",
        message:
          "فيه بيانات مش مسموح تتغيّر من هنا (زي الاسم والموبايل والمحفظة). كلّم موظف الاستقبال.",
        data: { fields: attempted },
      });
    }

    const { parent_phone, alt_phone, course_ids } = req.validated.body;
    const semesterId = req.validated.body.semester_id ?? null;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        name: true,
        is_active: true,
        tenant_id: true,
        branch_id: true,
        enrollments: {
          select: {
            id: true,
            course_id: true,
            status: true,
            semester_id: true,
          },
        },
      },
    });

    if (!student || !student.is_active) {
      return res
        .status(404)
        .json({ success: false, message: "الحساب مش موجود." });
    }

    if (
      parent_phone !== undefined &&
      !validateEgyptianPhone(parent_phone.trim())
    ) {
      return res.status(400).json({
        success: false,
        code: "BAD_PARENT_PHONE",
        message: "رقم ولي الأمر مش مظبوط.",
      });
    }
    if (alt_phone && !validateEgyptianPhone(alt_phone.trim())) {
      return res.status(400).json({
        success: false,
        code: "BAD_ALT_PHONE",
        message: "الرقم الاحتياطي مش مظبوط.",
      });
    }

    // ── الفصل ─────────────────────────────────────────────
    let semester = null;
    if (semesterId != null) {
      const list = await tenantSemesters(student.tenant_id);
      if (!list.some((x) => x.id === semesterId)) {
        return res.status(400).json({
          success: false,
          code: "BAD_SEMESTER",
          message: "الصف اللي اخترته مش متاح في الفرع ده.",
        });
      }
      semester = semesterId;
    }

    const ops = [];

    ops.push(
      prisma.student.update({
        where: { id: studentId },
        data: {
          ...(parent_phone !== undefined && {
            parent_phone: parent_phone.trim(),
          }),
          ...(alt_phone !== undefined && {
            alt_phone: alt_phone?.trim() || null,
          }),
        },
      }),
    );

    // ── المواد ────────────────────────────────────────────
    if (course_ids !== undefined) {
      const allowed = await branchCourses(student.tenant_id, student.branch_id);
      const allowedIds = new Set(allowed.map((c) => c.id));
      const wanted = new Set(
        [...new Set(course_ids)].filter((id) => allowedIds.has(id)),
      );

      const current = student.enrollments.filter((e) => e.course_id !== null);
      const currentIds = new Set(current.map((e) => e.course_id));

      // ⚠ مادة مدفوع فيها مايشلهاش من موبايله — ده بيمسح أثر
      //   مالي والموظف مش هيعرف حصل إيه
      const locked = new Set(
        current.filter((e) => e.status !== "unpaid").map((e) => e.course_id),
      );

      const toRemove = current.filter(
        (e) => !wanted.has(e.course_id) && !locked.has(e.course_id),
      );
      const toAdd = [...wanted].filter((id) => !currentIds.has(id));

      if (toRemove.length) {
        ops.push(
          prisma.enrollment.deleteMany({
            where: { id: { in: toRemove.map((e) => e.id) } },
          }),
        );
      }

      for (const courseId of toAdd) {
        ops.push(
          prisma.enrollment.create({
            data: {
              tenant_id: student.tenant_id,
              student_id: student.id,
              course_id: courseId,
              semester_id: semester ?? currentSemesterOf(student),
              start_date: new Date(),
              status: "unpaid",
            },
          }),
        );
      }
    }

    // ⚠ تغيير الفصل بيتطبّق على التسجيلات **غير المدفوعة** بس.
    //   التسجيل المدفوع بيخص فصل اتحصّل فلوسه فعلاً — نقله لفصل
    //   تاني بيحرّك إيراد من ترم لترم والتقارير القديمة بتتغيّر.
    if (semester != null) {
      const movable = student.enrollments
        .filter((e) => e.status === "unpaid" && e.semester_id !== semester)
        .map((e) => e.id);

      if (movable.length) {
        ops.push(
          prisma.enrollment.updateMany({
            where: { id: { in: movable } },
            data: { semester_id: semester },
          }),
        );
      }
    }

    await prisma.$transaction(ops);

    notify("students_updated", {}, student.tenant_id);

    res.json({ success: true, message: "اتحفظت البيانات." });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/portal/me/qr ────────────────────────────────
/// الطالب بيغيّر رمزه بنفسه.
///
/// ⚠ الرمز ده هو نفسه اللي الماسح بيقرا بيه الحضور —
///   `attendance.controller` بيدوّر بـ `portal_code`. يعني أي كارت
///   اتطبع أو اتصوّر قبل كده بيبطل فوراً. ده المقصود من
///   الزرار: للي كارته اتسرّب.
///
/// الجلسة الحالية مابتقفلش — التوكن متوقّع على `sid` مش على الكود.
const regenerateMyQr = async (req, res, next) => {
  try {
    const studentId = req.portal.studentId;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        is_active: true,
        tenant: { select: { is_active: true } },
      },
    });

    if (!student || !student.is_active || !student.tenant?.is_active) {
      return res
        .status(404)
        .json({ success: false, message: "الطالب مش موجود." });
    }

    const portalCode = await generateUniquePortalCode(prisma);
    const qrCode = await generateQRCode(portalCode);

    if (!qrCode) {
      return res
        .status(503)
        .json({ success: false, message: "فشل توليد الرمز — جرّب تاني." });
    }

    await prisma.student.update({
      where: { id: studentId },
      data: { portal_code: portalCode },
    });

    // شاشات الموظفين تحدّث الكود عندها
    notify("students_updated", {}, req.portal.tenantId);

    res.json({
      success: true,
      message: "اتعمل رمز جديد. الكارت القديم مابقاش شغّال.",
      data: { portal_code: portalCode, qr_code: qrCode },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getRegisterForm,
  submitRegistration,
  registrationStatus,
  openPortalSession,
  portalAuth,
  getMe,
  updateMe,
  regenerateMyQr,
  // للاستعمال من موديول الموظفين
  PORTAL_AUDIENCE,
  newLinkToken: () => crypto.randomBytes(24).toString("base64url"),
};
