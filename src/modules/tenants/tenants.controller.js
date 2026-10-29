// src/modules/tenants/tenants.controller.js
const prisma = require("../../config/db");
const bcrypt = require("bcryptjs");
const { notifyUser, disconnectUser } = require("../../core/sse");
const {
  TENANT_FEATURES,
  parseFeatures,
  serializeFeatures,
  publicStatus,
  endOfDay,
  addDays,
} = require("../../core/subscription");

/** الأعمدة اللي الفلاتر محتاجاها في أي رد عن سنتر */
const tenantSelect = {
  id: true,
  name: true,
  slug: true,
  email_domain: true,
  phone: true,
  address: true,
  features: true,
  subscription_ends_at: true,
  is_trial: true,
  is_active: true,
  created_at: true,
};

/**
 * `YYYY-MM-DD` → آخر لحظة في اليوم ده **بالتوقيت المحلي**.
 *
 * ⚠ بنركّبه من الأرقام مش بـ `new Date(string)`: الصيغة دي بتتقرا
 *   UTC، فاللي دفع لحد ٢٠ نوفمبر كان ممكن يتقفل من أول ٢٠ نوفمبر
 *   على سيرفر غرب جرينتش.
 */
const localEndOfDay = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
};

/** صف السنتر → الشكل اللي الفلاتر بتقراه */
const shape = (t) => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  email_domain: t.email_domain,
  phone: t.phone,
  address: t.address,
  features: parseFeatures(t.features),
  is_active: t.is_active,
  created_at: t.created_at,
  ...publicStatus(t),
  ...(t._count ? { _count: t._count } : {}),
});

// ── GET /api/tenants ──────────────────────────────────────
// قائمة كل السناتر (للـ dropdown بتاع الـ super_admin)
const getTenants = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      // الشغّال الأول وبعدين الأحدث
      orderBy: [{ is_active: "desc" }, { created_at: "desc" }],
      select: {
        ...tenantSelect,
        _count: {
          select: { branches: true, users: true, students: true },
        },
      },
    });
    res.json({ success: true, data: tenants.map(shape) });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/tenants ─────────────────────────────────────
// إنشاء سنتر جديد + أول فرع + حساب صاحب السنتر (super_admin بس)
const createTenant = async (req, res, next) => {
  try {
    const {
      name,
      slug,
      email_domain,
      phone,
      trial_days,
      features,
      owner_name,
      owner_email,
      owner_password,
      branch_name,
      branch_address,
      branch_phone,
    } = req.validated.body;

    const cleanSlug = slug.toLowerCase().trim();
    const cleanDomain = email_domain.toLowerCase().replace(/^@/, "").trim();
    const cleanEmail = owner_email.toLowerCase().trim();

    // ① إيميل صاحب السنتر لازم على دومين السنتر
    const emailDomain = cleanEmail.split("@")[1];
    if (emailDomain !== cleanDomain) {
      return res.status(400).json({
        success: false,
        message: `إيميل صاحب السنتر لازم يكون على دومين السنتر (@${cleanDomain}).`,
      });
    }

    // ② فحص التكرار قبل أي كتابة
    //
    // ⚠ فحص الدومين كان ناقص خالص. لو سنترين على نفس الدومين،
    //   قاعدة "كل حساب في السنتر لازم يكون على دومينه" بتنهار
    //   والحسابات بتتلخبط بين السنترين.
    const [slugTaken, domainTaken, emailTaken] = await Promise.all([
      prisma.tenant.findUnique({
        where: { slug: cleanSlug },
        select: { id: true, name: true },
      }),
      prisma.tenant.findFirst({
        where: { email_domain: cleanDomain },
        select: { id: true, name: true },
      }),
      prisma.user.findUnique({
        where: { email: cleanEmail },
        select: { id: true },
      }),
    ]);

    if (slugTaken) {
      return res.status(409).json({
        success: false,
        message: `الـ slug "${cleanSlug}" مستخدم بالفعل في "${slugTaken.name}".`,
      });
    }
    if (domainTaken) {
      return res.status(409).json({
        success: false,
        message: `الدومين "${cleanDomain}" مستخدم بالفعل في "${domainTaken.name}" — كل سنتر لازم دومين مختلف.`,
      });
    }
    if (emailTaken) {
      return res.status(409).json({
        success: false,
        message: `الإيميل "${cleanEmail}" موجود بالفعل.`,
      });
    }

    // ③ الهاش برّه الـ transaction — bcrypt بياخد ~300ms
    //    وقفل الـ transaction طول المدة دي بلا لزوم
    const hashedPassword = await bcrypt.hash(owner_password, 12);

    // ④ الاشتراك: الفترة التجريبية بتبدأ من النهاردة.
    //
    //    ⚠ آخر لحظة في اليوم الأخير مش أول لحظة فيه — تجربة
    //      «٧ أيام» لازم تشمل اليوم السابع كله.
    const endsAt = endOfDay(addDays(new Date(), trial_days));
    const planFeatures = serializeFeatures(features);

    // ⑤ التلاتة مع بعض أو ولا حاجة
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: name.trim(),
          slug: cleanSlug,
          email_domain: cleanDomain,
          phone: phone?.trim() || null,
          features: planFeatures,
          subscription_ends_at: endsAt,
          is_trial: true,
          is_active: true,
        },
        select: tenantSelect,
      });

      const branch = await tx.branch.create({
        data: {
          tenant_id: tenant.id,
          name: (branch_name || "الفرع الرئيسي").trim(),
          address: branch_address || null,
          phone: branch_phone || null,
          is_active: true,
        },
      });

      // ⚠ الدور هنا `owner` مش `admin`.
      //
      //   الـ admin بياخد فروعه من user_branch_access، والـ endpoint
      //   ده مش بيعمله ولا صف — فكان بيطلع حساب مقفول على نفسه:
      //   getAllowedBranchIds بترجّع [] فمش شايف ولا فرع في سنتره.
      //
      //   الـ owner وصوله لكل فروع سنتره ضمني (FULL_ACCESS_ROLES)،
      //   وده اللي create-tenant.js بيعمله، وده اللي الـ RBAC متصمّم عليه:
      //   الأونر بينشئ المديرين ويوزّع عليهم الفروع.
      const owner = await tx.user.create({
        data: {
          tenant_id: tenant.id,
          branch_id: branch.id,
          name: owner_name.trim(),
          email: cleanEmail,
          password: hashedPassword,
          role: "owner",
          is_active: true,
        },
        select: { id: true, name: true, email: true, role: true },
      });

      return { tenant, branch, owner };
    });

    res.status(201).json({
      success: true,
      message: `تم إنشاء "${result.tenant.name}".`,
      data: {
        // ⚠ الباسورد مش هنا: الشاشة هي اللي كتبته وهي اللي
        //   هتحطه في مسج الواتس. مفيش داعي يرجع من السيرفر.
        tenant: shape(result.tenant),
        branch: { id: result.branch.id, name: result.branch.name },
        owner: result.owner,
      },
    });
  } catch (err) {
    if (err.code === "P2002") {
      const field = err.meta?.target?.[0] || "قيمة";
      return res.status(409).json({
        success: false,
        message: `القيمة دي (${field}) مستخدمة بالفعل.`,
      });
    }
    next(err);
  }
};

// ── PUT /api/tenants/:id ──────────────────────────────────
// تعديل سنتر (تفعيل/إيقاف، تغيير اسم) — super_admin بس
const updateTenant = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const {
      name,
      is_active,
      phone,
      address,
      features,
      subscription_ends_at,
      is_trial,
    } = req.validated.body;

    const existing = await prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, is_active: true },
    });
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "السنتر مش موجود." });
    }

    const deactivating = is_active === false && existing.is_active === true;

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(is_active !== undefined && { is_active }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(address !== undefined && { address: address?.trim() || null }),
        // ⚠ قصّ الفيتشرز هنا كمان: أي اسم مش في TENANT_FEATURES
        //   بيتشال، فمفيش حاجة غريبة بتتخزّن في العمود
        ...(features !== undefined && {
          features: serializeFeatures(features),
        }),

        // ⚠ تعديل التاريخ هنا **مابيفعّلش** السنتر زي التجديد:
        //   ده تصحيح إداري، والتفعيل فعل مستقل بزراره.
        //   و`null` = اشتراك مفتوح بلا نهاية.
        ...(subscription_ends_at !== undefined && {
          subscription_ends_at: subscription_ends_at
            ? localEndOfDay(subscription_ends_at)
            : null,
        }),
        ...(is_trial !== undefined && { is_trial }),
      },
      select: tenantSelect,
    });

    // ⚠ إيقاف السنتر كان بيمنع اللوجن الجديد بس.
    //   اللي داخل بالفعل كان بيفضل شغال لحد ما التوكن ينتهي —
    //   ٧ أيام بإعداد JWT_EXPIRES_IN الحالي. يعني توقف عميل
    //   مدفعش وهو شغال عادي أسبوع كامل.
    //
    //   token_version بيتزوّد → كل التوكنات الحالية تبقى باطلة فوراً.
    let loggedOut = 0;
    if (deactivating) {
      const users = await prisma.user.findMany({
        where: { tenant_id: id },
        select: { id: true },
      });

      await prisma.user.updateMany({
        where: { tenant_id: id },
        data: { token_version: { increment: 1 }, last_seen_at: null },
      });

      for (const u of users) {
        notifyUser(u.id, "force_logout", {});
        disconnectUser(u.id);
      }
      loggedOut = users.length;
    }

    res.json({
      success: true,
      message: deactivating
        ? `تم إيقاف "${tenant.name}" وتسجيل خروج ${loggedOut} مستخدم.`
        : "تم تحديث السنتر.",
      data: shape(tenant),
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/tenants/:id/renew ───────────────────────────
// تجديد اشتراك سنتر لتاريخ محدد — super_admin بس
const renewTenant = async (req, res, next) => {
  try {
    const id = req.validated.params.id;
    const { ends_at, is_trial } = req.validated.body;

    const existing = await prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, is_active: true },
    });
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "السنتر مش موجود." });
    }

    const endsAt = localEndOfDay(ends_at);

    if (endsAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: "التاريخ ده عدّى خلاص — اختار تاريخ في المستقبل.",
      });
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        subscription_ends_at: endsAt,
        is_trial: is_trial ?? false,
        // ⚠ التجديد بيرجّع السنتر للشغل: لو كان متوقف (مدفعش)
        //   التجديد معناه إنه دفع. لو كان متوقف لسبب تاني،
        //   الإيقاف بزرار مستقل والسوبر أدمن يقدر يرجّعه.
        is_active: true,
      },
      select: tenantSelect,
    });

    res.json({
      success: true,
      message: `تم تجديد اشتراك "${tenant.name}".`,
      data: shape(tenant),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTenants,
  createTenant,
  updateTenant,
  renewTenant,
  TENANT_FEATURES,
};
