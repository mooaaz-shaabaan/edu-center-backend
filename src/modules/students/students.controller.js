// src/modules/students/students.controller.js
const prisma = require("../../config/db");
const { generateQRCode } = require("../../utils/qrGenerator");
const { generatePortalCode } = require("../../utils/portalCode");
const { validateEgyptianPhone } = require("../../utils/phoneValidator");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");
const { resolveShiftId } = require("../../core/currentShift");
const { resolveDrawerId, sendDrawerError } = require("../../core/drawerScope");

// ── Helper: يتأكد إن الفرع تابع لنفس السنتر ────────────────
const assertBranchInTenant = async (branchId, tenantId) => {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, tenant_id: true },
  });
  if (!branch || branch.tenant_id !== tenantId) {
    const err = new Error("Branch not found in this center.");
    err.status = 400;
    throw err;
  }
};

// ── GET /api/students ─────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { name, branch_id, course_id, all_branches, is_active } =
      req.validated.query;
    const page = req.validated.query.page || 1;
    const limit = req.validated.query.limit || 20;

    // tenantWhere بيفلتر بالسنتر تلقائيًا
    const where = { ...tenantWhere(req) };

    // ⚠ قبل كده كان `is_active: true` مثبّت في الكود — يعني الطالب
    //   الموقوف بيختفي من الواجهة خالص. والسيرفر بيقول للموظف
    //   "وقّف الطالب بدل ما تحذفه" وبعدها الطالب بيتبخّر ومفيش
    //   أي شاشة تشوفه منها تاني أو ترجّعه.
    //
    //   دلوقتي:
    //     مفيش باراميتر → الشغّالين بس (نفس السلوك القديم)
    //     is_active=false → الموقوفين بس
    //     is_active=all   → الاتنين
    //   ⚠ بنطبّع القيمة قبل المقارنة: لو الراوت استخدم
    //     `z.enum` هتوصل نص، ولو استخدم transform لـ boolean
    //     هتوصل `false` — و `false === "false"` بترجّع false،
    //     فالفلتر كان بيتجاهل بصمت ويرجّع الشغّالين.
    const activeFilter = String(is_active ?? "").toLowerCase();

    if (activeFilter === "all") {
      // من غير فلتر — الشغّالين والموقوفين
    } else if (activeFilter === "false" || activeFilter === "0") {
      where.is_active = false;
    } else {
      where.is_active = true;
    }

    if (name) {
      where.OR = [
        { name: { contains: name, mode: "insensitive" } },
        { phone: { contains: name } },
        { parent_phone: { contains: name } },
        { portal_code: { contains: name } },
      ];
    }

    // ← لو all_branches=true، نتجاهل فلتر الفرع (بيفضل مفلتر بالـ tenant بس)
    if (!all_branches && branch_id) where.branch_id = branch_id;

    if (course_id) {
      where.enrollments = { some: { course_id } };
    }

    const skip = (page - 1) * limit;

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        where,
        skip,
        take: limit,
        // ترتيب أبجدي.
        //
        // ⚠ الـ `id` مش زيادة: من غير مُرجِّح ثابت، أي طالبين بنفس
        //   الاسم ترتيبهم بيبقى عشوائي في كل استعلام، فالطالب ممكن
        //   يظهر في صفحة ١ و ٢ أو ما يظهرش خالص مع الـ pagination.
        //
        // ⚠ الترتيب الصح للهمزات (أ إ آ ← ا) والتاء المربوطة محتاج
        //   collation عربي على العمود — شوف الـ migration في الشرح.
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: {
          id: true,
          name: true,
          phone: true,
          parent_phone: true,
          alt_phone: true,
          portal_code: true,
          branch_id: true,
          is_active: true,
          created_at: true,
          updated_at: true,
          sync_status: true,
          shift_id: true,
          wallet_enabled: true,
          wallet_balance: true,
          branch: { select: { id: true, name: true } },
          enrollments: {
            include: { course: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.student.count({ where }),
    ]);

    res.json({
      success: true,
      data: students,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/students/:id ─────────────────────────────────
const getOne = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const student = await prisma.student.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        enrollments: { include: { course: true, installments: true } },
        attendance: { orderBy: { date: "desc" }, take: 10 },
        payments: { orderBy: { paid_at: "desc" }, take: 10 },
      },
    });

    // بيرمي 404 لو مش موجود أو من سنتر تاني
    assertSameTenant(req, student);

    res.json({ success: true, data: student });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/students ────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const {
      name,
      phone,
      parent_phone,
      alt_phone,
      branch_id,
      shift_id,
      wallet_enabled,
    } = req.validated.body;

    // السنتر من اليوزر (super_admin لازم يكون مختار سنتر)
    const tenantId = requireTenantId(req);

    if (!validateEgyptianPhone(phone)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid phone number. Must start with 010/011/012/015 and be 11 digits.",
      });
    }
    if (!validateEgyptianPhone(parent_phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid parent phone number.",
      });
    }

    // تأكد إن الفرع تابع لنفس السنتر
    await assertBranchInTenant(branch_id, tenantId);

    const cleanName = normalizeName(name);
    const cleanPhone = phone.trim();

    const duplicate = await findDuplicate(tenantId, cleanPhone);
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: duplicate.is_active
          ? `الرقم ده متسجّل بالفعل للطالب «${duplicate.name}» في ${duplicate.branch?.name ?? "السنتر"}.`
          : `الرقم ده متسجّل للطالب «${duplicate.name}» (غير مفعّل) في ${duplicate.branch?.name ?? "السنتر"} — فعّله بدل ما تضيفه من جديد.`,
        data: { existing_id: duplicate.id, is_active: duplicate.is_active },
      });
    }

    const portalCode = generatePortalCode();
    const qrCode = await generateQRCode(portalCode);

    const student = await prisma.student.create({
      data: {
        tenant_id: tenantId, // ← الختم
        name: cleanName,
        phone: cleanPhone,
        parent_phone,
        alt_phone: alt_phone || null,
        branch_id,
        portal_code: portalCode,
        qr_code: qrCode,
        shift_id: shift_id || null,
        wallet_enabled: wallet_enabled === true,
        wallet_balance: 0,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        parent_phone: true,
        alt_phone: true,
        portal_code: true,
        qr_code: true,
        branch_id: true,
        is_active: true,
        created_at: true,
        sync_status: true,
        shift_id: true,
        wallet_enabled: true,
        wallet_balance: true,
        branch: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: "Student created successfully.",
      data: student,
    });
  } catch (err) {
    if (err.code === "P2002") {
      const target = err.meta?.target;
      // بعد ما الـ unique بقى (tenant_id, phone) الاسم مبقاش في الـ target
      const isPhone = Array.isArray(target) && target.includes("phone");

      return res.status(409).json({
        success: false,
        message: isPhone
          ? "الرقم ده متسجّل لطالب تاني في السنتر."
          : "A student with this code already exists.",
      });
    }
    next(err);
  }
};

// ── PUT /api/students/:id ─────────────────────────────────
//
// ⚠ نقل الطالب لفرع تاني بيحصل هنا لما `branch_id` يوصل في الـ body.
//   الـ ApiClient في فلاتر كان بيحقن `branch_id` في **كل** طلب، فأي
//   تعديل (تفعيل المحفظة، تغيير تليفون) كان بينقل الطالب للفرع اللي
//   الموظف واقف فيه من غير ما حد يطلب. الإصلاح في الـ ApiClient:
//   الحقن بقى للـ POST بس.
//
//   سايبين السلوك هنا زي ما هو عن قصد — «بعت branch_id يعني عايز
//   تغيّره» صح، بشرط إن اللي بيبعته هو المستخدم مش الـ interceptor.
const update = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const {
      name,
      phone,
      parent_phone,
      alt_phone,
      branch_id,
      is_active,
      photo,
      wallet_enabled,
    } = req.validated.body;

    // تأكد إن الطالب موجود وتابع لنفس السنتر
    const existing = await prisma.student.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, existing);

    // ⚠ الفاليديشن قبل فحص التكرار — كان بالعكس، فرقم غلط
    //   كان بيتفحص في الداتابيز الأول من غير لزوم
    if (phone && !validateEgyptianPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number.",
      });
    }

    // بيغيّر التليفون؟ اتأكد إنه مش هيتصادم مع طالب تاني
    if (phone !== undefined) {
      const duplicate = await findDuplicate(
        existing.tenant_id,
        phone.trim(),
        id,
      );

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `الرقم ده متسجّل للطالب «${duplicate.name}» في ${duplicate.branch?.name ?? "السنتر"}.`,
        });
      }
    }
    if (parent_phone && !validateEgyptianPhone(parent_phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid parent phone number.",
      });
    }

    // لو بيغيّر الفرع، تأكد إنه في نفس السنتر
    if (branch_id !== undefined) {
      await assertBranchInTenant(branch_id, existing.tenant_id);
    }

    const student = await prisma.student.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: normalizeName(name) }),
        ...(phone !== undefined && { phone: phone.trim() }),
        ...(parent_phone !== undefined && { parent_phone }),
        ...(alt_phone !== undefined && { alt_phone }),
        ...(branch_id !== undefined && { branch_id }),
        ...(is_active !== undefined && { is_active }),
        ...(photo !== undefined && { photo }),
        ...(wallet_enabled !== undefined && { wallet_enabled }),
        // ملاحظة: wallet_balance مش هنا عمدًا — الرصيد يتغيّر بالشحن/الخصم بس
      },
      select: {
        id: true,
        name: true,
        phone: true,
        parent_phone: true,
        alt_phone: true,
        portal_code: true,
        branch_id: true,
        is_active: true,
        created_at: true,
        sync_status: true,
        shift_id: true,
        wallet_enabled: true,
        wallet_balance: true,
        branch: { select: { id: true, name: true } },
        enrollments: {
          include: { course: { select: { id: true, name: true } } },
        },
      },
    });

    res.json({
      success: true,
      message: "Student updated successfully.",
      data: student,
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "الرقم ده متسجّل لطالب تاني في السنتر.",
      });
    }
    next(err);
  }
};

// ── DELETE /api/students/:id (Admin فقط) ─────────────────
/// ⚠ الطالب اللي عليه سجل مالي أو حضور **مايتحذفش**.
///
///   قبل كده كان `prisma.student.delete` على طول — والـ FK
///   بيرمي P2003 اللي بيوصل للواجهة كـ 400 "Database operation
///   failed"، فالموظف بيشوف "فشل حذف الطالب" ومش عارف ليه
///   ولا إن البديل هو الإيقاف.
///
///   وحتى لو نجح، ده بيمسح تاريخ مدفوعات من الداتابيز — يعني
///   تقارير الشهر بتتغيّر بأثر رجعي والدرج مايطبّقش.
const remove = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const existing = await prisma.student.findUnique({
      where: { id },
      select: { id: true, tenant_id: true, name: true, is_active: true },
    });
    assertSameTenant(req, existing);

    const [payments, attendance, enrollments] = await Promise.all([
      prisma.payment.count({ where: { student_id: id } }),
      prisma.attendance.count({ where: { student_id: id } }),
      prisma.enrollment.count({ where: { student_id: id } }),
    ]);

    if (payments > 0 || attendance > 0) {
      const parts = [];
      if (payments > 0) parts.push(`${payments} عملية دفع`);
      if (attendance > 0) parts.push(`${attendance} تسجيل حضور`);

      return res.status(400).json({
        success: false,
        code: "STUDENT_HAS_HISTORY",
        message:
          `مينفعش تحذف "${existing.name}" — عليه ${parts.join(" و")}. ` +
          `وقّف الطالب بدل ما تحذفه عشان التقارير القديمة تفضل صح.`,
        data: { payments, attendance, enrollments },
      });
    }

    // طالب لسه جديد ومفيش عليه أي حركة — التسجيلات بتتمسح معاه
    await prisma.$transaction([
      prisma.enrollment.deleteMany({ where: { student_id: id } }),
      prisma.student.delete({ where: { id } }),
    ]);

    res.json({ success: true, message: "Student deleted successfully." });
  } catch (err) {
    // شبكة أمان: أي علاقة تانية اتضافت بعدين ومااتفحصتش فوق
    if (err.code === "P2003") {
      return res.status(400).json({
        success: false,
        code: "STUDENT_HAS_HISTORY",
        message: "مينفعش تحذف الطالب — مرتبط بسجلات تانية. وقّفه بدل الحذف.",
      });
    }
    next(err);
  }
};

// ── GET /api/students/:id/qr ──────────────────────────────
const getQR = async (req, res, next) => {
  try {
    const id = req.validated.params.id;

    const student = await prisma.student.findUnique({
      where: { id },
      select: { qr_code: true, name: true, tenant_id: true },
    });

    assertSameTenant(req, student);

    res.json({
      success: true,
      data: { name: student.name, qr_code: student.qr_code },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/students/:id/wallet/charge ─────────────────
const chargeWallet = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { amount, shift_id } = req.validated.body;

    const student = await prisma.student.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        tenant_id: true,
        branch_id: true,
        wallet_enabled: true,
      },
    });

    assertSameTenant(req, student);

    if (!student.wallet_enabled) {
      return res.status(400).json({
        success: false,
        message: "Wallet is not enabled for this student.",
      });
    }

    /**
     * ⚠ الشحن فلوس داخلة صندوق — لازم يبقى ليها درج.
     *
     *   الوردية مش شرط: الأونر والأدمن مابيفتحوش ورديات. الدرج
     *   بيتحدد من الوردية لو فيه، وإلا من الفرع (أو المستخدم يختاره
     *   لو الفرع فيه أكتر من درج).
     *
     *   من غير الدرج، الشحن كان بيتسجّل بـ `shift_id: null` والفلوس
     *   تدخل الصندوق فعلاً وحسبة الدرج ماتشوفهاش — فأول جرد بعدها
     *   يطلّع فرق باسم اللي مالوش ذنب.
     */
    const shiftId = await resolveShiftId(prisma, req, shift_id);
    const drawerId = await resolveDrawerId(prisma, {
      tenantId: student.tenant_id,
      branchId: req.branchId,
      drawerId: req.validated?.body?.drawer_id ?? null,
      shiftId,
    });

    /**
     * ⚠ الدفعة بتتسجّل على **فرع القبض** مش فرع الطالب.
     *
     *   كان `branch_id: student.branch_id`. يعني ريسبشن عين شمس
     *   يشحن لطالب من النزهة → الدفعة تتسجّل على النزهة. النتيجة:
     *     · داشبورد عين شمس مش بتشوف فلوس هي قبضتها
     *     · داشبورد النزهة بتعرض إيراد مادخلش درجها
     *     · الدرج والداشبورد بيقولوا رقمين مختلفين لنفس الجنيه
     */
    const collectedBranchId = req.branchId ?? student.branch_id;

    // الشحن + الإيصال في transaction واحدة (يا الكل يا لا حاجة)
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.student.update({
        where: { id },
        data: { wallet_balance: { increment: amount } },
        select: { id: true, name: true, wallet_balance: true },
      });

      await tx.payment.create({
        data: {
          tenant_id: student.tenant_id, // ← الختم
          student_id: id,
          branch_id: collectedBranchId, // ← فرع القبض
          amount,
          shift_id: shiftId,
          drawer_id: drawerId, // ← الصندوق اللي الفلوس دخلته
          kind: "wallet_topup", // ← بديل التمييز بنص الملاحظات
          notes: "شحن محفظة",
          receipt_number: `W-${id}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
          created_by: req.user.id,
        },
      });

      return updated;
    });

    res.json({
      success: true,
      message: `تم شحن ${amount} جنيه في محفظة ${student.name}`,
      data: result,
    });
  } catch (err) {
    sendDrawerError(res, err, next);
  }
};

// ── Helper: تطبيع الاسم — مسافات زيادة متعملش طالب جديد ───
const normalizeName = (name) => (name || "").trim().replace(/\s+/g, " ");

// ── Helper: الطالب ده موجود قبل كده في نفس السنتر؟ ────────
//
// الرقم وحده هو هوية الطالب — الاسم مش جزء من الفحص
// (أخوين بنفس الاسم واردين، رقمين متطابقين لأ).
// كان فيه باراميتر `name` مش مستخدم، شيلته عشان ما يوهمش
// إن الفحص بالاسم كمان.
const findDuplicate = async (tenantId, phone, excludeId = null) =>
  prisma.student.findFirst({
    where: {
      tenant_id: tenantId,
      phone: (phone || "").trim(),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: {
      id: true,
      name: true,
      is_active: true,
      branch: { select: { id: true, name: true } },
    },
  });

module.exports = {
  getAll,
  getOne,
  create,
  update,
  remove,
  getQR,
  chargeWallet,
};
