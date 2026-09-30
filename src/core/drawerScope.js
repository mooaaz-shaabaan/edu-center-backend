// src/core/drawerScope.js
// ── الدرج اللي الحركة المالية بتتسجّل عليه ──────────────────
//
// الدرج مش مشتق من الوردية. الوردية بتقول "مين كان ماسك الدرج"،
// بس الفلوس بتدخل **درج** وتخرج من **درج** — والأونر والأدمن
// بيتعاملوا بفلوس من غير وردية أصلاً.
//
// عشان كده كل حركة (دفعة · مصروف · إيداع · سحب) شايلة `drawer_id`
// بنفسها، و `created_by` بيقول مين عملها.

/// خطأ بكود تعرفه الشاشة — عشان تعرف تفتح الدايالوج الصح
const codedError = (status, code, message, data = null) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.data = data;
  return err;
};

/** رد موحّد لأخطاء الدرج — الشاشة بتتصرّف على الـ code */
const sendDrawerError = (res, err, next) => {
  if (err?.code && typeof err.status === "number") {
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.data ? { data: err.data } : {}),
    });
  }
  return next(err);
};

/**
 * الدرج اللي هيتسجّل على الحركة.
 *
 *   ١) اللي بيعمل العملية عنده وردية → درج ورديته (الريسبشن، من غير
 *      ما حد يسأله)
 *   ٢) `drawer_id` مبعوت صراحة → لازم يكون في نفس الفرع وشغّال
 *   ٣) الفرع فيه درج شغّال واحد → هو (الحالة الغالبة للأونر والأدمن)
 *   ٤) أكتر من درج ومفيش وردية ولا اختيار → DRAWER_REQUIRED ومعاه
 *      القايمة، والشاشة تخلّيه يختار
 *
 * ⚠ ملاحظة مقصودة: مفيش "من غير درج". أي جنيه بيدخل السنتر أو يخرج
 *   منه لازم يكون ليه صندوق معروف، وإلا الجرد الجاي هيطلّع فرق باسم
 *   حد مالوش ذنب.
 */
const resolveDrawerId = async (
  db,
  { tenantId, branchId, drawerId = null, shiftId = null }
) => {
  // ١) درج الوردية
  if (shiftId) {
    const shift = await db.shift.findUnique({
      where: { id: shiftId },
      select: { drawer_id: true },
    });
    if (shift?.drawer_id) return shift.drawer_id;
  }

  // ٢) درج مبعوت صراحة
  if (drawerId) {
    const drawer = await db.cashDrawer.findFirst({
      where: {
        id: drawerId,
        tenant_id: tenantId,
        branch_id: branchId,
        is_active: true,
      },
      select: { id: true },
    });
    if (!drawer) {
      throw codedError(
        400,
        "DRAWER_WRONG_BRANCH",
        "الدرج ده مش في الفرع المختار أو موقوف."
      );
    }
    return drawer.id;
  }

  // ٣ و ٤) دروج الفرع
  const actives = await db.cashDrawer.findMany({
    where: { tenant_id: tenantId, branch_id: branchId, is_active: true },
    orderBy: { id: "asc" },
  });

  if (actives.length === 1) return actives[0].id;

  if (actives.length === 0) {
    throw codedError(
      400,
      "NO_DRAWER",
      "الفرع ده مالوش درج — لازم المدير يضيف درج الأول."
    );
  }

  throw codedError(
    400,
    "DRAWER_REQUIRED",
    "اختار الدرج اللي الفلوس هتدخله.",
    { drawers: actives }
  );
};

module.exports = { resolveDrawerId, codedError, sendDrawerError };