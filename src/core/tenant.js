// src/core/tenant.js
// ─────────────────────────────────────────────────────────
// الحارس (Tenant Isolation) — قلب حماية الـ multi-tenant
//
// الفكرة: كل query في النظام لازم تتفلتر بالـ tenant_id الصح.
// الملف ده بيوحّد إزاي نجيب الـ tenant_id ونبني شرط الفلترة،
// عشان منكررش الكود في كل موديول ومننساش الفلترة.
// ─────────────────────────────────────────────────────────

/**
 * بيرجّع الـ tenant_id الصح للـ request الحالي.
 *
 * - اليوزر العادي (admin / receptionist):
 *     الـ tenant_id بيتاخد من التوكن إجباريًا. أي tenant_id يبعته في
 *     الطلب بيتجاهل تمامًا (ميقدرش يتلصص على سنتر تاني).
 *
 * - الـ super_admin (انت):
 *     يقدر يختار سنتر من الـ dropdown. الاختيار بيتبعت في الطلب
 *     (query: ?tenant_id=  أو body: tenant_id) وبنقبله منه هو بس.
 *     لو مبعتش حاجة → بيرجّع null (يعني "كل السناتر" — للتقارير العامة).
 *
 * بيرجّع:
 *   - رقم tenant_id (لليوزر العادي، أو super_admin اللي اختار سنتر)
 *   - null (super_admin من غير اختيار = الكل)
 */
const resolveTenantId = (req) => {
  const user = req.user;

  if (!user) {
    // المفروض ميحصلش لأن auth middleware بيجي الأول، بس حماية إضافية
    const err = new Error("Unauthorized.");
    err.status = 401;
    throw err;
  }

  // ── super_admin: يختار السنتر من الطلب ──────────────────
  if (user.role === "super_admin") {
    const raw =
      req.body?.tenant_id ?? req.query?.tenant_id ?? req.params?.tenant_id;

    if (raw === undefined || raw === null || raw === "") {
      return null; // مفيش اختيار → الكل (للتقارير العامة)
    }

    const tid = Number(raw);
    if (!Number.isInteger(tid) || tid <= 0) {
      const err = new Error("Invalid tenant_id.");
      err.status = 400;
      throw err;
    }
    return tid;
  }

  // ── اليوزر العادي: الـ tenant_id من التوكن إجباريًا ─────
  // (أي tenant_id في الطلب بيتجاهل — ده الأمان)
  if (!user.tenant_id) {
    // يوزر عادي من غير سنتر = حالة غلط، نمنعه
    const err = new Error("No tenant associated with this account.");
    err.status = 403;
    throw err;
  }

  return user.tenant_id;
};

/**
 * بيرجّع شرط الفلترة الجاهز لأي Prisma query.
 *
 * الاستخدام في الموديولز:
 *   const where = { ...tenantWhere(req), is_active: true };
 *   prisma.student.findMany({ where });
 *
 * - لو فيه tenant_id → بيرجّع { tenant_id: X }
 * - لو null (super_admin بيشوف الكل) → بيرجّع {} (مفيش فلتر)
 */
const tenantWhere = (req) => {
  const tid = resolveTenantId(req);
  return tid === null ? {} : { tenant_id: tid };
};

/**
 * بيرجّع الـ tenant_id اللي لازم يتحط وقت إنشاء سجل جديد (create).
 *
 * الاستخدام:
 *   const tenantId = requireTenantId(req);
 *   prisma.student.create({ data: { ...body, tenant_id: tenantId } });
 *
 * بيرفض لو مفيش tenant_id محدد — لأن إنشاء سجل من غير سنتر ممنوع.
 * (الـ super_admin لازم يختار سنتر قبل ما ينشئ بيانات فيه).
 */
const requireTenantId = (req) => {
  const tid = resolveTenantId(req);
  if (tid === null) {
    const err = new Error(
      "A tenant must be selected to create records. (super_admin: choose a center first)",
    );
    err.status = 400;
    throw err;
  }
  return tid;
};

/**
 * بيتأكد إن سجل جايّ من الـ DB تابع لنفس سنتر اليوزر.
 * بيستخدم بعد ما تجيب سجل بالـ id، قبل ما تعدّله أو تحذفه،
 * عشان متعدّلش/تحذف سجل من سنتر تاني.
 *
 * الاستخدام:
 *   const student = await prisma.student.findUnique({ where: { id } });
 *   assertSameTenant(req, student); // بيرمي 404 لو مش نفس السنتر
 */
const assertSameTenant = (req, record) => {
  if (!record) {
    const err = new Error("Record not found.");
    err.status = 404;
    throw err;
  }

  // super_admin اللي بيشوف الكل (مختارش سنتر) → بيعدّي
  const tid = resolveTenantId(req);
  if (tid === null) return;

  if (record.tenant_id !== tid) {
    // مهم: نرجّع 404 مش 403 — عشان متديش المهاجم تلميح إن السجل موجود
    const err = new Error("Record not found.");
    err.status = 404;
    throw err;
  }
};

async function assertShiftInTenant(prisma, shiftId, tenantId) {
  if (!shiftId) return; // مفيش شيفت = مفيش مشكلة
  if (tenantId === null) return; // super_admin (بيشوف الكل)
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: { id: true, tenant_id: true },
  });
  if (!shift || shift.tenant_id !== tenantId) {
    const err = new Error("Shift not found in this center.");
    err.status = 400;
    throw err;
  }
}

module.exports = {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
  resolveTenantId,
  assertShiftInTenant,
};
