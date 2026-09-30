// src/core/currentShift.js
// ── الجلسة اللي العملية تتسجل عليها ─────────────────────────
// الكاش اللي بيتقبض لازم يدخل درج **اللي قبضه**، على **فرعه**.
// من غير كده الدفعة/المصروف بيتسجلوا بـ shift_id = null
// وتقرير الجلسة (closeShiftWithTotals) مش بيشوفهم خالص.

/**
 * @param shiftId الجلسة اللي البرنامج بعتها (اختيارية)
 *
 * ⚠ الـ shift_id المبعوت مش بيتاخد على إطلاقه.
 *
 *   قبل كده كان `if (shiftId) return shiftId;` — والفحص الوحيد
 *   عليه (`assertShiftInTenant`) بيتأكد إنه في نفس السنتر بس.
 *   يعني موظف يبعت رقم جلسة زميله، والكاش يدخل درج الزميل
 *   ويظهر في تقريره هو. ولا خطأ ولا أثر.
 *
 *   دلوقتي: لازم تكون جلسته هو، مفتوحة، وعلى نفس الفرع. لو
 *   مش كده بنتجاهلها ونرجع لجلسته المفتوحة — مش بنرمي خطأ،
 *   عشان القاعدة دي («الفلوس تدخل درج اللي قبضها») مالهاش
 *   استثناء يستاهل نوقف العملية عشانه.
 */
const resolveShiftId = async (db, req, shiftId) => {
  if (!req.user?.id) return null;

  const mine = {
    user_id: req.user.id,
    closed_at: null,
    // الدرج لكل فرع: متربطش عملية فرع بجلسة فرع تاني
    ...(req.branchId ? { branch_id: req.branchId } : {}),
  };

  if (shiftId) {
    const owned = await db.shift.findFirst({
      where: { id: shiftId, ...mine },
      select: { id: true },
    });
    if (owned) return owned.id;
    // مش بتاعته → بنكمّل تحت وناخد جلسته الحقيقية
  }

  const open = await db.shift.findFirst({
    where: mine,
    select: { id: true },
    orderBy: { opened_at: "desc" },
  });

  return open?.id ?? null;
};

module.exports = { resolveShiftId };
