// src/modules/attendance/attendance.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertShiftInTenant,
} = require("../../core/tenant");
const { getAllowedBranchIds } = require("../../core/branchScope");
const { resolveShiftId } = require("../../core/currentShift");
const { resolveDrawerId, sendDrawerError } = require("../../core/drawerScope");

// ── Helpers ───────────────────────────────────────────────
/// ⚠ كل حسابات اليوم والساعة هنا بتوقيت السيرفر المحلي.
///   لو السيرفر شغال UTC والسنتر في مصر، اليوم هيتقفل الساعة ٣ الفجر
///   وحساب "متأخر" هيبقى غلط ٣ ساعات.
///   الحل: TZ=Africa/Cairo في environment بتاع السيرفر.
const dayStart = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const startOfToday = () => dayStart();

const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();

/// "15:30" → 930 · بترجّع null لو الصيغة بايظة بدل ما ترمي NaN
const parseTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

const fmtTime = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/// الفروع المسموح بيها للطلب الحالي.
///
/// ⚠ `requireBranchAccess("attendance")` بيسيب `allowedBranchIds`
///   محسوبة حسب الفيتشر. لو الميدل وير ده مش على المسار لأي سبب،
///   بنرجع لفروع اليوزر كلها بدل ما نسيب الاستعلام من غير أي قيد.
const allowedBranches = (req) =>
  req.allowedBranchIds !== undefined
    ? req.allowedBranchIds
    : getAllowedBranchIds(req.user);

/// بيضيف قيد الفرع على أي استعلام قراءة.
///
/// ⚠ من غير الـ `else` دي، طلب من غير `branch_id` كان بيرجّع
///   حضور **كل فروع السنتر** — والمسارات دي `required: false`
///   يعني الطلب ده مقبول. نفس الشكل اللي كان في قايمة
///   المستخدمين بالظبط.
const scopeToBranch = (req, where) => {
  if (req.branchId) {
    where.branch_id = req.branchId;
    return where;
  }
  const allowed = allowedBranches(req);
  if (allowed) where.branch_id = { in: allowed };
  return where;
};

/// الفرع موجود في السنتر وشغّال؟ — الفرع الموقوف مايتسجّلش عليه حضور
const assertBranchUsable = async (tenantId, branchId) => {
  if (!branchId) {
    const err = new Error("Branch is required.");
    err.status = 400;
    throw err;
  }

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, tenant_id: tenantId },
    select: { id: true, name: true, is_active: true },
  });

  if (!branch) {
    const err = new Error("Branch not found in this center.");
    err.status = 404;
    throw err;
  }
  if (!branch.is_active) {
    const err = new Error(
      `الفرع "${branch.name}" موقوف — مينفعش تسجّل عليه حضور.`,
    );
    err.status = 400;
    throw err;
  }
  return branch;
};

const computePaymentPlan = (student, coursePrice, paymentMode) => {
  const price = Number(coursePrice) || 0;

  if (price <= 0) {
    return { method: "none", walletDebit: 0, cashAmount: 0 };
  }
  if (!student.wallet_enabled) {
    return { method: "cash", walletDebit: 0, cashAmount: price };
  }
  const balance = Number(student.wallet_balance) || 0;
  if (paymentMode === "cash") {
    return { method: "cash", walletDebit: 0, cashAmount: price };
  }
  if (balance >= price) {
    return { method: "wallet", walletDebit: price, cashAmount: 0 };
  }
  if (paymentMode === "split") {
    return {
      method: "split",
      walletDebit: balance,
      cashAmount: price - balance,
    };
  }
  return {
    method: "insufficient",
    walletDebit: 0,
    cashAmount: 0,
    balance,
    required: price,
    shortfall: price - balance,
  };
};

// ── حصص المادة النهاردة ───────────────────────────────────
/// ⚠ `CourseSchedule.branch_id` ممكن تبقى null (الميعاد في كل
///   الفروع) أو فرع معيّن. الكود القديم كان بيجيب كل المواعيد من
///   غير فلتر فرع — يعني مادة معادها ١٠ص في المعادي و ٨م في مدينة
///   نصر، الطالب اللي بيسجّل في المعادي الساعة ٨م كان بيتحسب
///   "حاضر" بسبب ميعاد فرع تاني.
const getTodaySessions = async (courseId, tenantId, branchId, now) => {
  const schedules = await prisma.courseSchedule.findMany({
    where: {
      course_id: courseId,
      tenant_id: tenantId,
      day_of_week: now.getDay(), // 0=الأحد ... 6=السبت
      OR: [{ branch_id: null }, { branch_id: branchId }],
    },
    select: { start_time: true },
  });

  // ميعاد عام + ميعاد فرع بنفس الساعة = حصة واحدة مش اتنين
  const seen = new Set();
  const out = [];
  for (const s of schedules) {
    const start = parseTime(s.start_time);
    if (start === null || seen.has(start)) continue;
    seen.add(start);
    out.push(start);
  }
  return out.sort((a, b) => a - b);
};

/// بيحدّد الطالب جاي لأنهي حصة — الأقرب لوقته.
/// التعادل بيروح للحصة الأحدث (الأقرب في المستقبل).
const pickSession = (sessions, now) => {
  if (sessions.length === 0) return { sessionNo: 1, start: null };

  const nowMin = minutesOf(now);
  let bestIdx = 0;
  let bestDiff = Infinity;

  sessions.forEach((start, i) => {
    const diff = Math.abs(nowMin - start);
    if (diff <= bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });

  return { sessionNo: bestIdx + 1, start: sessions[bestIdx] };
};

// ── الحصة + الحالة (حاضر/متأخر) ───────────────────────────
/// ⚠ الكود القديم كان بيلف على **كل** مواعيد اليوم ويرجّع "حاضر"
///   لو الوقت أقل من أي ميعاد + السماح. يعني مادة مواعيدها ١٠ص
///   و ٨م، الطالب اللي جه ١١ص (متأخر ساعة) كان بيتسجّل حاضر لأن
///   حصة ٨م لسه جاية. دلوقتي بنحدّد الحصة الأقرب الأول وبعدين
///   نحسب الحالة عليها هي بس.
/// [wanted] = الحصة اللي الموظف اختارها من الواجهة.
///   لو مبعوتش (سكان QR سريع مثلاً) بنختار الأقرب لوقته.
const resolveSession = async (
  courseId,
  tenantId,
  branchId,
  now = new Date(),
  wanted = null,
) => {
  const course = await prisma.course.findFirst({
    where: { id: courseId, tenant_id: tenantId },
    select: { grace_minutes: true },
  });

  const grace = course?.grace_minutes ?? 15;
  const sessions = await getTodaySessions(courseId, tenantId, branchId, now);
  const auto = pickSession(sessions, now);

  let sessionNo = auto.sessionNo;
  let start = auto.start;

  if (wanted != null) {
    // مفيش مواعيد النهاردة → الحصة الوحيدة المسموحة هي ١
    const max = sessions.length || 1;
    if (wanted < 1 || wanted > max) {
      const err = new Error(
        sessions.length === 0
          ? "المادة دي مالهاش مواعيد النهاردة."
          : `المادة ليها ${max} حصص النهاردة بس — الحصة رقم ${wanted} مش موجودة.`,
      );
      err.status = 400;
      err.code = "SESSION_NOT_FOUND";
      throw err;
    }
    sessionNo = wanted;
    start = sessions.length ? sessions[wanted - 1] : null;
  }

  // مفيش ميعاد النهاردة → حصة واحدة افتراضية والحالة "حاضر"
  const status =
    start === null
      ? "present"
      : minutesOf(now) <= start + grace
        ? "present"
        : "late";

  return {
    sessionNo,
    sessionsToday: sessions.length,
    startMinutes: start,
    startLabel: start === null ? null : fmtTime(start),
    status,
    recommendedNo: auto.sessionNo,
    grace,
    allStarts: sessions,
  };
};

// ── GET /api/attendance/sessions ──────────────────────────
/// مواعيد المادة النهاردة في الفرع الحالي — الواجهة بتبني منها
/// الدروب داون التاني لما المادة يبقى ليها أكتر من حصة.
const listSessions = async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const branchId = req.branchId;
    const courseId = req.validated.query.course_id;

    // ⚠ تاريخ بايظ بيدّي `Invalid Date` و`getDay()` بترجّع NaN،
    //   والاستعلام بيضرب بخطأ مالوش معنى للمستخدم
    const raw = req.validated.query.date;
    const now = raw ? new Date(raw) : new Date();
    if (isNaN(now.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date." });
    }

    const course = await prisma.course.findFirst({
      where: { id: courseId, tenant_id: tenantId },
      select: { id: true, name: true, grace_minutes: true },
    });

    if (!course) {
      return res
        .status(404)
        .json({ success: false, message: "Course not found in this center." });
    }

    const starts = await getTodaySessions(courseId, tenantId, branchId, now);
    const grace = course.grace_minutes ?? 15;
    const nowMin = minutesOf(now);
    const { sessionNo: recommendedNo } = pickSession(starts, now);

    const sessions = starts.map((start, i) => ({
      session_no: i + 1,
      start_time: fmtTime(start),
      // لو سجّلت دلوقتي في الحصة دي، هتتحسب إيه
      status_now: nowMin <= start + grace ? "present" : "late",
      is_recommended: i + 1 === recommendedNo,
    }));

    res.json({
      success: true,
      data: {
        course_id: course.id,
        course_name: course.name,
        grace_minutes: grace,
        recommended_session: starts.length ? recommendedNo : null,
        sessions,
      },
    });
  } catch (err) {
    next(err);
  }
};

/// نص الرسالة لما الحضور يبقى مكرر
const duplicateMessage = ({ studentName, courseName, session, existing }) => {
  const when = existing?.date
    ? ` (اتسجّل ${fmtTime(minutesOf(new Date(existing.date)))})`
    : "";

  if (session.sessionsToday <= 1) {
    return `"${studentName}" مسجّل حضور في "${courseName}" النهاردة${when}.`;
  }

  const which = session.startLabel
    ? `حصة ${session.startLabel}`
    : `الحصة رقم ${session.sessionNo}`;

  return (
    `"${studentName}" مسجّل في ${which} بتاعة "${courseName}"${when}. ` +
    `المادة ليها ${session.sessionsToday} حصص النهاردة — سجّله في الحصة التانية في ميعادها.`
  );
};

// بينفّذ تسجيل الحضور + الدفع كله في transaction واحدة
//
// [date] و [attendanceDay] للمزامنة الأوفلاين — الصف بيتكتب بوقت
// التسجيل الفعلي مش وقت الرفع. من غيرهم كل سجلات الأوفلاين بتتكتب
// بتاريخ النهاردة ويوم الحضور القديم بيضيع.
const createAttendanceWithPayment = async ({
  student,
  tenantId,
  branchId,
  shiftId,
  drawerId = null,
  courseId,
  method,
  status,
  sessionNo,
  notes,
  plan,
  createdBy,
  date = null,
  attendanceDay = null,
}) => {
  return prisma.$transaction(async (tx) => {
    if (plan.walletDebit > 0) {
      const updated = await tx.student.updateMany({
        where: {
          id: student.id,
          wallet_balance: { gte: plan.walletDebit },
        },
        data: { wallet_balance: { decrement: plan.walletDebit } },
      });
      if (updated.count === 0) {
        const err = new Error("Wallet balance changed. Please retry.");
        err.status = 409;
        throw err;
      }
    }

    if (plan.cashAmount > 0) {
      await tx.payment.create({
        data: {
          tenant_id: tenantId,
          student_id: student.id,
          amount: plan.cashAmount,
          shift_id: shiftId || null,
          // ← الصندوق اللي الكاش دخله. من غيره كاش الحضور — وهو
          //   أكبر مصدر دخل يومي — بيفضل بره حسبة الدرج.
          drawer_id: drawerId || null,
          kind: "attendance",
          branch_id: branchId,
          notes:
            plan.method === "split"
              ? "دفع مقسّم (محفظة + كاش) عند الحضور"
              : "دفع نقدي عند الحضور",
          receipt_number: `ATT-${student.id}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
          created_by: createdBy ?? null, // ← مين استلم الكاش
        },
      });
    }

    const payment_method = plan.method === "none" ? null : plan.method;

    const attendance = await tx.attendance.create({
      data: {
        tenant_id: tenantId,
        student_id: student.id,
        branch_id: branchId,
        shift_id: shiftId || null,
        course_id: courseId,
        ...(date ? { date } : {}),
        attendance_day: attendanceDay ?? startOfToday(),
        session_no: sessionNo,
        method,
        status,
        notes: notes || null,
        payment_method,
        wallet_debited: plan.walletDebit,
        cash_paid: plan.cashAmount,
        sync_status: "synced",
        student_name: student.name,
        student_phone: student.phone,
      },
      include: {
        student: { select: { id: true, name: true } },
        course: { select: { id: true, name: true } },
      },
    });

    return attendance;
  });
};

// ── GET /api/attendance ───────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { student_id, date } = req.validated.query;
    const page = req.validated.query.page || 1;
    const limit = req.validated.query.limit || 20;

    const where = scopeToBranch(req, { ...tenantWhere(req) });
    if (student_id) where.student_id = student_id;

    // ⚠ كان بيفلتر على `date` (timestamp) بمدى يوم.
    //   `attendance_day` هو عمود اليوم الفعلي وعليه الـ unique index،
    //   فالمقارنة بالتساوي أسرع ومافيهاش لخبطة توقيت.
    if (date) where.attendance_day = dayStart(new Date(date));

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: "desc" },
        include: {
          student: { select: { id: true, name: true, phone: true } },
          shift: { select: { id: true, opened_at: true } },
          course: { select: { id: true, name: true } },
        },
      }),
      prisma.attendance.count({ where }),
    ]);

    res.json({
      success: true,
      data: records,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── دالة مشتركة للتسجيل (QR + Manual) ─────────────────────
//
// ⚠ الترتيب اتغيّر. كان: مسجّل في المادة؟ → احسب الفلوس → لو
//   المحفظة مش كافية ٤٠٢ → نفّذ (والتكرار بيتمسك من الداتابيز
//   كـ P2002 بعد كل ده).
//
//   يعني طالب حضر خلاص ومحفظته فاضية، الموظف يمسح كوده تاني
//   فيطلع له "المحفظة مش كافية — ادفع كاش" بدل "الطالب مسجّل
//   النهاردة"، وممكن ياخد منه فلوس تاني.
//
//   دلوقتي: الطالب → مفعّل؟ → مسجّل في المادة؟ → حضر الحصة دي
//   خلاص؟ → وبعدين بس نتكلم في فلوس.
const handleRecord = async (req, res, next, { method, identifier }) => {
  try {
    const body = req.validated.body;
    const courseId = body.course_id;
    let shiftId = body.shift_id || null;
    const paymentMode = body.payment_mode;
    const tenantId = requireTenantId(req);
    const now = new Date();

    // ١) الفرع لازم يكون محدد وشغّال قبل أي حاجة
    const branchId = req.branchId;
    await assertBranchUsable(tenantId, branchId);

    if (shiftId) {
      await assertShiftInTenant(prisma, shiftId, tenantId);
    }
    // ← يتربط بجلسة الموظف (الكاش اللي هيتدفع لازم يدخل درج الجلسة)
    shiftId = await resolveShiftId(prisma, req, shiftId);

    // ٢) الطالب
    let student;
    if (identifier === "qr") {
      student = await prisma.student.findFirst({
        // ⚠ بـ `portal_code` بس. كان فيه فرع تاني بيقارن
        //   الممسوح بـ `qr_code` — وده كان فيه **صورة PNG
        //   بـ base64**، مستحيل الماسح يطلّعها. فرع ميت
        //   بيكلفنا مسح عمود نصّي تقيل في كل تسجيل حضور.
        where: { tenant_id: tenantId, portal_code: body.qr_content },
        include: { enrollments: { include: { course: true } } },
      });
    } else {
      student = await prisma.student.findFirst({
        where: { id: body.student_id, tenant_id: tenantId },
        include: { enrollments: { include: { course: true } } },
      });
    }

    if (!student) {
      return res
        .status(404)
        .json({ success: false, message: "Student not found." });
    }

    // ⚠ الطالب الموقوف كان لسه بيتسجّل حضور عادي — الإيقاف كان
    //   بيخفيه من القوايم بس. لو كوده متطبوع على كارت، الكارت
    //   بيفضل شغّال.
    if (!student.is_active) {
      return res.status(400).json({
        success: false,
        code: "STUDENT_INACTIVE",
        message: `"${student.name}" موقوف — فعّله الأول من صفحة الطلاب عشان تسجّل له حضور.`,
      });
    }

    // ٣) مسجّل في المادة؟
    const enrollment = student.enrollments.find(
      (e) => e.course_id === courseId,
    );
    if (!enrollment) {
      return res.status(400).json({
        success: false,
        message: "Student is not enrolled in this course.",
      });
    }

    const courseName = enrollment.course?.name || "المادة";
    const coursePrice = Number(enrollment.course?.price ?? 0);

    // ٤) أنهي حصة النهاردة + حاضر ولا متأخر
    //    الموظف بيختار الحصة من الواجهة لما المادة يبقى ليها
    //    أكتر من ميعاد؛ لو مختارش بنجيب الأقرب لوقته
    const session = await resolveSession(
      courseId,
      tenantId,
      branchId,
      now,
      body.session_no ?? null,
    );

    // ⚠ الفورم بيبعت `status: 'present'` مثبّت في الكود ومفيش
    //   في الواجهة أي طريقة يغيّره بيها. لو خدنا كلامه على
    //   إطلاقه، كل تسجيل بيبقى "حاضر" وحساب التأخير كله بيموت
    //   — وده اللي حصل فعلاً: متأخر بقى صفر في الداشبورد.
    //
    //   فـ "present" مش قرار، هو الافتراضي. اللي بيتحسب من
    //   الموظف هو بس لما يقول حاجة مختلفة (غايب أو متأخر).
    const override = body.status;
    const status =
      override === "absent" || override === "late" ? override : session.status;

    // ٥) حضر الحصة دي خلاص؟
    //
    //    الفحص ده مش بديل للـ unique index — ده عشان الرسالة
    //    تبقى مفهومة، والـ index عشان موظفين اتنين مايسجّلوش
    //    نفس الطالب في نفس اللحظة.
    const existing = await prisma.attendance.findFirst({
      where: {
        tenant_id: tenantId,
        student_id: student.id,
        course_id: courseId,
        attendance_day: startOfToday(),
        session_no: session.sessionNo,
      },
      select: { id: true, date: true, status: true },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        code: "ATTENDANCE_DUPLICATE",
        message: duplicateMessage({
          studentName: student.name,
          courseName,
          session,
          existing,
        }),
        data: {
          attendance_id: existing.id,
          session_no: session.sessionNo,
          sessions_today: session.sessionsToday,
        },
      });
    }

    // ٦) دلوقتي بس نتكلم في فلوس
    //    الغياب مش بيتدفع عليه حاجة
    const plan =
      status === "absent"
        ? { method: "none", walletDebit: 0, cashAmount: 0 }
        : computePaymentPlan(student, coursePrice, paymentMode);

    if (plan.method === "insufficient") {
      return res.status(402).json({
        success: false,
        message: "wallet_insufficient",
        data: {
          student_id: student.id,
          student_name: student.name,
          wallet_balance: plan.balance,
          course_price: plan.required,
          shortfall: plan.shortfall,
          method, // "qr" | "manual" — الواجهة بتعتمد عليها
        },
      });
    }

    // ٧) الصندوق — بس لو فيه كاش فعلاً
    //
    // ⚠ الحضور المدفوع من المحفظة مافيهوش كاش، فمش محتاج درج.
    //   لو طلبنا درج في الحالة دي، فرع فيه أكتر من درج هيرفض تسجيل
    //   حضور مالوش علاقة بالصندوق أصلاً.
    let drawerId = null;
    if (plan.cashAmount > 0) {
      drawerId = await resolveDrawerId(prisma, {
        tenantId,
        branchId,
        drawerId: body.drawer_id ?? null,
        shiftId,
      });
    }

    // ٨) نفّذ
    let attendance;
    try {
      attendance = await createAttendanceWithPayment({
        student,
        tenantId,
        branchId,
        shiftId,
        drawerId,
        courseId,
        method,
        status,
        sessionNo: session.sessionNo,
        notes: body.notes,
        plan,
        createdBy: req.user.id,
      });
    } catch (e) {
      // سباق: موظف تاني سجّله في نفس اللحظة
      if (e.code === "P2002") {
        return res.status(409).json({
          success: false,
          code: "ATTENDANCE_DUPLICATE",
          message: duplicateMessage({
            studentName: student.name,
            courseName,
            session,
            existing: null,
          }),
        });
      }
      throw e;
    }

    const sessionSuffix =
      session.sessionsToday > 1 && session.startLabel
        ? ` — حصة ${session.startLabel}`
        : "";

    // ⚠ لازم الرسالة تقول حصل إيه في الفلوس، مش «تم التسجيل» وبس.
    //
    //   تلات حالات مختلفة تمامًا كانت بتطلع بنفس البانر الأخضر:
    //
    //     طالب مش مفعّل له محفظة  → **لازم الموظف يقبض كاش**
    //     طالب معاه رصيد          → اتخصم، مايقبضش حاجة
    //     مادة سعرها صفر          → مجاني
    //
    //   في الزحمة الموظف بيمسح ويبص على البانر ثانية واحدة. لو
    //   الحالتين شكلهم واحد، إما بيقبض من حد دافع من محفظته،
    //   وإما بيسيب حد يعدّي من غير ما يدفع — والفرق ده بيبان
    //   آخر اليوم في عجز الدرج، ومحدش يعرف جه منين.
    const walletAfter = Number(student.wallet_balance || 0) - plan.walletDebit;
    const money = (n) => `${Math.round(n * 100) / 100} ج`;

    let payNote = "";
    switch (plan.method) {
      case "cash":
        payNote = ` — اقبض ${money(plan.cashAmount)} كاش`;
        break;
      case "wallet":
        payNote =
          ` — اتخصم ${money(plan.walletDebit)} من المحفظة` +
          ` (باقي ${money(walletAfter)})`;
        break;
      case "split":
        payNote =
          ` — اتخصم ${money(plan.walletDebit)} من المحفظة` +
          ` · اقبض ${money(plan.cashAmount)} كاش`;
        break;
      default:
        payNote = " — مجاني";
    }

    return res.status(201).json({
      success: true,
      message: `تم تسجيل حضور ${student.name}${sessionSuffix}${payNote}`,
      data: {
        ...attendance,
        session_no: session.sessionNo,
        sessions_today: session.sessionsToday,
        session_start: session.startLabel,
        // الواجهة بتلوّن البانر من دول — أصفر لما يبقى فيه كاش
        // في إيد الموظف، أخضر لما يبقى خلاص
        payment_mode: plan.method,
        cash_due: plan.cashAmount,
        wallet_debited: plan.walletDebit,
        wallet_balance_after: plan.method === "none" ? null : walletAfter,
      },
    });
  } catch (err) {
    // NO_DRAWER / DRAWER_REQUIRED بتوصل للشاشة بالكود بتاعها
    sendDrawerError(res, err, next);
  }
};

const recordByQR = (req, res, next) =>
  handleRecord(req, res, next, { method: "qr", identifier: "qr" });

const recordManual = (req, res, next) =>
  handleRecord(req, res, next, { method: "manual", identifier: "id" });

// ── POST /api/attendance/sync ─────────────────────────────
//
// ⚠ الدالة دي كانت بتكتب الحضور مباشرة وتحط `payment_method: "cash"`
//   ثابتة — **من غير ما تعمل صف Payment ولا تخصم من المحفظة**.
//   يعني الحضور بيتسجّل "مدفوع كاش" والفلوس مش موجودة في أي درج
//   ولا في الإيرادات. وكمان كانت بتتخطى فحص الطالب الموقوف
//   والتسجيل في المادة — الاتنين اللي `handleRecord` بيمنعهم.
//
//   دلوقتي بتعدّي على نفس مسار الدفع بالظبط. ولو المحفظة مش
//   كافية ومفيش حد قدام الشاشة يقرر، الحضور بيتسجّل **من غير
//   دفع** والنتيجة بترجع `synced_unpaid` — أحسن من إننا نكتب
//   "كاش" على فلوس محدش شافها.
const syncOffline = async (req, res, next) => {
  try {
    const { records } = req.validated.body;
    const tenantId = requireTenantId(req);
    const branchId = req.branchId;
    await assertBranchUsable(tenantId, branchId);

    const results = [];

    for (const record of records) {
      const studentId = record.student_id;

      try {
        const courseId = record.course_id || null;
        const recordDate = new Date(record.date);
        if (isNaN(recordDate.getTime())) {
          results.push({
            student_id: studentId,
            status: "failed",
            reason: "bad_date",
          });
          continue;
        }
        const recordDay = dayStart(recordDate);

        const student = await prisma.student.findFirst({
          where: { id: studentId, tenant_id: tenantId },
          include: { enrollments: { include: { course: true } } },
        });

        if (!student) {
          results.push({
            student_id: studentId,
            status: "failed",
            reason: "not_found",
          });
          continue;
        }

        if (!student.is_active) {
          results.push({
            student_id: studentId,
            status: "failed",
            reason: "inactive",
          });
          continue;
        }

        // مسجّل في المادة؟ (نفس شرط التسجيل المباشر)
        let enrollment = null;
        if (courseId) {
          enrollment = student.enrollments.find(
            (e) => e.course_id === courseId,
          );
          if (!enrollment) {
            results.push({
              student_id: studentId,
              status: "failed",
              reason: "not_enrolled",
            });
            continue;
          }
        }

        // ⚠ الجلسة اللي جاية من الجهاز الأوفلاين لازم تتفحص —
        //   من غير الفحص ده ينفع تربط الحضور بجلسة سنتر تاني
        let shiftId = record.shift_id || null;
        if (shiftId) {
          await assertShiftInTenant(prisma, shiftId, tenantId);
        }
        shiftId = await resolveShiftId(prisma, req, shiftId);

        // الحصة والحالة بيتحسبوا بوقت التسجيل الفعلي مش وقت الرفع
        const session = courseId
          ? await resolveSession(
              courseId,
              tenantId,
              branchId,
              recordDate,
              record.session_no ?? null,
            )
          : {
              sessionNo: record.session_no ?? 1,
              status: "present",
              sessionsToday: 0,
              startLabel: null,
            };

        // نفس قاعدة التسجيل المباشر: "حاضر" افتراضي مش قرار
        const override = record.status;
        const status =
          override === "absent" || override === "late"
            ? override
            : session.status;

        const coursePrice = Number(enrollment?.course?.price ?? 0);
        let plan =
          status === "absent"
            ? { method: "none", walletDebit: 0, cashAmount: 0 }
            : computePaymentPlan(student, coursePrice, undefined);

        let shortfall = 0;
        if (plan.method === "insufficient") {
          shortfall = plan.shortfall;
          plan = { method: "none", walletDebit: 0, cashAmount: 0 };
        }

        // الصندوق — بس لو فيه كاش. المزامنة مفيهاش حد قدام الشاشة
        // يختار، فلو الفرع فيه أكتر من درج ومفيش وردية، الصف بيفشل
        // بـ `no_drawer` بدل ما الكاش يتسجّل في المجهول.
        let drawerId = null;
        if (plan.cashAmount > 0) {
          try {
            drawerId = await resolveDrawerId(prisma, {
              tenantId,
              branchId,
              drawerId: record.drawer_id ?? null,
              shiftId,
            });
          } catch (e) {
            results.push({
              student_id: studentId,
              status: "failed",
              reason: "no_drawer",
            });
            continue;
          }
        }

        await createAttendanceWithPayment({
          student,
          tenantId,
          branchId,
          shiftId,
          drawerId,
          courseId,
          method: record.method || "manual",
          status,
          sessionNo: session.sessionNo,
          notes: record.notes,
          plan,
          createdBy: req.user.id,
          date: recordDate,
          attendanceDay: recordDay,
        });

        results.push(
          shortfall > 0
            ? {
                student_id: studentId,
                student_name: student.name,
                status: "synced_unpaid",
                shortfall,
              }
            : { student_id: studentId, status: "synced" },
        );
      } catch (e) {
        if (e.code === "P2002") {
          results.push({
            student_id: studentId,
            status: "failed",
            reason: "duplicate",
          });
        } else {
          results.push({
            student_id: studentId,
            status: "failed",
            reason: "error",
          });
        }
      }
    }

    const unpaid = results.filter((r) => r.status === "synced_unpaid").length;

    res.json({
      success: true,
      message: unpaid
        ? `المزامنة خلصت — ${unpaid} طالب اتسجّل من غير دفع، حصّلهم يدوي.`
        : "المزامنة خلصت.",
      data: results,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/attendance/summary ───────────────────────────
/// ⚠ `absent` هيفضل صفر — الغياب مش بيتسجّل في الجدول أصلاً،
///   الصف بيتكتب لما الطالب يحضر بس. الغياب بيتحسب مشتق
///   (المسجّلين ناقص الحاضرين) زي ما بيحصل في الداشبورد.
const getSummary = async (req, res, next) => {
  try {
    const { student_id } = req.validated.query;
    const days = req.validated.query.days || 7;

    const from = dayStart();
    from.setDate(from.getDate() - days);

    const where = scopeToBranch(req, {
      ...tenantWhere(req),
      attendance_day: { gte: from },
    });
    if (student_id) where.student_id = student_id;

    // ⚠ كان بيجيب كل الصفوف بالـ include ويجمّع في الجافاسكريبت —
    //   ٢٠٠ طالب × ٣٠ يوم = آلاف الصفوف في كل طلب.
    const rows = await prisma.attendance.groupBy({
      by: ["student_id", "status"],
      where,
      _count: { _all: true },
    });

    if (rows.length === 0) return res.json({ success: true, data: [] });

    const studentIds = [...new Set(rows.map((r) => r.student_id))];
    const students = await prisma.student.findMany({
      where: { id: { in: studentIds }, ...tenantWhere(req) },
      select: { id: true, name: true, portal_code: true },
    });
    const studentById = Object.fromEntries(students.map((s) => [s.id, s]));

    const summary = {};
    for (const r of rows) {
      const student = studentById[r.student_id];
      if (!student) continue;

      summary[r.student_id] ??= { student, present: 0, absent: 0, late: 0 };
      if (summary[r.student_id][r.status] !== undefined) {
        summary[r.student_id][r.status] += r._count._all;
      }
    }

    res.json({ success: true, data: Object.values(summary) });
  } catch (err) {
    next(err);
  }
};

/// للتوافق مع أي ملف لسه بيستدعي الاسم القديم
/// (`dashboard.controller` بيستوردها — اتأكد قبل ما تمسحها)
const computeAttendanceStatus = async (
  courseId,
  tenantId,
  now = new Date(),
  branchId = null,
) => (await resolveSession(courseId, tenantId, branchId, now)).status;

module.exports = {
  getAll,
  listSessions,
  recordByQR,
  recordManual,
  syncOffline,
  getSummary,
  resolveSession,
  computeAttendanceStatus,
};
