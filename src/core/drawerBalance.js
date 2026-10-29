// src/core/drawerBalance.js
// ── رصيد الدرج وكشف حركته ───────────────────────────────────
// الدرج مش بتاع وردية. أكتر من موظف ممكن يفتحوا على نفس الدرج،
// والأونر والأدمن بيتعاملوا بفلوس من غير وردية أصلاً — فالحركة
// نفسها هي اللي شايلة `drawer_id`، والوردية مجرد معلومة إضافية.
//
// الرصيد = آخر مرة حد عدّ الدرج + كل اللي دخل وخرج بعدها.
// والعجز مش بتاع وردية كمان — هو بتاع **لحظة عدّ**، وبيتسجّل في
// DrawerCount باسم اللي عدّ.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sumOf = (agg) => Number(agg?._sum?.amount || 0);

/**
 * الرصيد اللي المفروض يكون في الدرج دلوقتي.
 *
 * ⚠ الفلترة بـ `created_at` مش `paid_at` / `expense_date` —
 *   الاتنين دول المستخدم بيقدر يحطهم بتاريخ قديم (دفعة بتاريخ
 *   امبارح)، والدرج بيهمه الفلوس دخلت الصندوق إمتى **فعلاً**.
 *
 * ⚠ الفلترة بقت على `drawer_id` مباشرة بدل `shift: { drawer_id }`.
 *   الـ join القديم كان بيسقط أي حركة من غير وردية — يعني كل فلوس
 *   الأونر والأدمن كانت خارج الحسبة.
 */
const drawerMovementsWhere = (drawerId, since) => ({
  drawer_id: drawerId,
  created_at: { gt: since },
});

const expectedBalance = async (db, drawer) => {
  const since = drawer.last_counted_at ?? drawer.created_at;
  const base = drawerMovementsWhere(drawer.id, since);

  const [pay, dep, exp, wd] = await Promise.all([
    db.payment.aggregate({ where: base, _sum: { amount: true } }),
    db.cashTransaction.aggregate({
      where: { ...base, type: "deposit" },
      _sum: { amount: true },
    }),
    db.expense.aggregate({ where: base, _sum: { amount: true } }),
    db.cashTransaction.aggregate({
      where: { ...base, type: "withdrawal" },
      _sum: { amount: true },
    }),
  ]);

  return round2(
    Number(drawer.last_counted_balance) +
      sumOf(pay) +
      sumOf(dep) -
      sumOf(exp) -
      sumOf(wd),
  );
};

// ══════════════════════════════════════════════════════════
// كشف حركة الدرج
// ══════════════════════════════════════════════════════════
const USER_PICK = { select: { id: true, name: true } };

const KIND_LABEL = {
  fee: "دفعة",
  wallet_topup: "شحن محفظة",
  attendance: "كاش حضور",
  registration: "قبول طالب",
  other: "دفعة",
};

const COUNT_REASON = {
  open: "استلام الدرج",
  close: "تسليم الدرج",
  handover: "تسليم بين موظفين",
  audit: "جرد إداري",
};

/**
 * كل حركة على الدرج في قايمة واحدة مرتّبة بالوقت، وكل صف شايل
 * **مين عملها**.
 *
 * `since` اختياري — من غيره بيرجّع من آخر جرد (اللي بيفسّر الرصيد
 * الحالي)، وبيه بيرجّع من أي تاريخ.
 */
/**
 * مجموع الداخل والخارج في فترة — **من الداتابيز، مش من الصفوف
 * المعروضة**.
 *
 * ⚠ الكشف بيعرض آخر 100 حركة بس. لو حسبنا الإجمالي بجمع
 *   المعروض، الملخص بيكدب على الدرج اللي عليه حركة أكتر من
 *   كده — ومحدش بياخد باله لأن الأرقام شكلها معقول.
 */
const drawerTotals = async (db, drawer, from) => {
  const base = drawerMovementsWhere(drawer.id, from);

  const [pay, dep, exp, wd] = await Promise.all([
    db.payment.aggregate({ where: base, _sum: { amount: true } }),
    db.cashTransaction.aggregate({
      where: { ...base, type: "deposit" },
      _sum: { amount: true },
    }),
    db.expense.aggregate({ where: base, _sum: { amount: true } }),
    db.cashTransaction.aggregate({
      where: { ...base, type: "withdrawal" },
      _sum: { amount: true },
    }),
  ]);

  return {
    totalIn: round2(sumOf(pay) + sumOf(dep)),
    totalOut: round2(sumOf(exp) + sumOf(wd)),
  };
};

const drawerLedger = async (
  db,
  drawer,
  { limit = 100, since = null, opening = null } = {},
) => {
  const from = since ?? drawer.last_counted_at ?? drawer.created_at;
  const base = drawerMovementsWhere(drawer.id, from);

  const [payments, expenses, cash, counts] = await Promise.all([
    db.payment.findMany({
      where: base,
      orderBy: { created_at: "desc" },
      take: limit,
      select: {
        id: true,
        kind: true,
        amount: true,
        notes: true,
        receipt_number: true,
        created_at: true,
        shift_id: true,
        student: { select: { id: true, name: true } },
        created_by_user: USER_PICK,
      },
    }),
    db.expense.findMany({
      where: base,
      orderBy: { created_at: "desc" },
      take: limit,
      select: {
        id: true,
        category: true,
        description: true,
        amount: true,
        created_at: true,
        shift_id: true,
        created_by_user: USER_PICK,
      },
    }),
    db.cashTransaction.findMany({
      where: base,
      orderBy: { created_at: "desc" },
      take: limit,
      select: {
        id: true,
        type: true,
        amount: true,
        reason: true,
        created_at: true,
        shift_id: true,
        created_by_user: USER_PICK,
      },
    }),
    // ⚠ الجرد حركة على الدرج زي أي حركة — بل أهمها.
    //
    //   هو اللي **بيصفّر الدفتر**: لما حد يعدّ ويلاقي رقم غير
    //   اللي السيستم شايفه، الفرق بيتشال والدرج بيكمّل من
    //   الرقم المعدود. وكان مش ظاهر في الكشف خالص — فاللي
    //   بيدقّق بيمشي على الحركات ويوصل لرقم غير اللي قدامه
    //   ومايعرفش العجز جه منين.
    db.drawerCount.findMany({
      where: { drawer_id: drawer.id, counted_at: { gt: from } },
      orderBy: { counted_at: "desc" },
      take: limit,
      select: {
        id: true,
        reason: true,
        counted: true,
        note: true,
        counted_at: true,
        shift_id: true,
        user: USER_PICK,
      },
    }),
  ]);

  const rows = [
    ...payments.map((p) => ({
      id: `payment-${p.id}`,
      kind: p.kind,
      label: KIND_LABEL[p.kind] ?? "دفعة",
      direction: "in",
      amount: Number(p.amount),
      subject: p.student?.name ?? null,
      note: p.notes,
      ref: p.receipt_number,
      by: p.created_by_user?.name ?? null,
      by_id: p.created_by_user?.id ?? null,
      shift_id: p.shift_id,
      at: p.created_at,
    })),
    ...expenses.map((e) => ({
      id: `expense-${e.id}`,
      kind: "expense",
      label: "مصروف",
      direction: "out",
      amount: Number(e.amount),
      subject: e.category,
      note: e.description,
      ref: null,
      by: e.created_by_user?.name ?? null,
      by_id: e.created_by_user?.id ?? null,
      shift_id: e.shift_id,
      at: e.created_at,
    })),
    ...counts.map((c) => ({
      id: `count-${c.id}`,
      kind: "count",
      label: "جرد",
      // الاتجاه بيتحدّد بعدين من فرق التسوية الحقيقي
      direction: null,
      amount: null,
      countedTo: Number(c.counted),
      subject: COUNT_REASON[c.reason] ?? "جرد",
      note: c.note,
      ref: null,
      by: c.user?.name ?? null,
      by_id: c.user?.id ?? null,
      shift_id: c.shift_id,
      at: c.counted_at,
    })),
    ...cash.map((c) => ({
      id: `cash-${c.id}`,
      kind: c.type === "deposit" ? "deposit" : "withdrawal",
      label: c.type === "deposit" ? "إيراد آخر" : "سحب من الدرج",
      direction: c.type === "deposit" ? "in" : "out",
      amount: Number(c.amount),
      subject: null,
      note: c.reason,
      ref: null,
      by: c.created_by_user?.name ?? null,
      by_id: c.created_by_user?.id ?? null,
      shift_id: c.shift_id,
      at: c.created_at,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const trimmed = rows.slice(0, limit);

  // الرصيد الجاري بعد كل حركة — بنحسب من الأقدم للأحدث وبعدين
  // نرجّع الترتيب، عشان الصف الأول (الأحدث) يطلع بالرصيد الحالي
  //
  // ⚠ البداية بتتبعت من برّه. كانت `last_counted_balance` على
  //   طول — وده غلط في كشف «من أول الدرج»: بيعيد الحركة من
  //   الصفر فالمفروض يبدأ من صفر، مش من رقم جرد حصل في النص.
  let running = opening !== null ? Number(opening) : Number(drawer.last_counted_balance);

  let totalIn = 0;
  let totalOut = 0;

  const ordered = [...trimmed].reverse().map((r) => {
    if (r.kind === "count") {
      // ⚠ الجرد **بيحطّ** الرصيد مش بيزوّده. والتسوية هي الفرق
      //   بين اللي اتعدّ واللي الدفتر وصل له — مش `variance`
      //   المسجّل (ده الفرق عن حساب السيستم وقتها، ومش لازم
      //   يساوي مشي الكشف من الأول).
      const adjust = round2(r.countedTo - running);
      running = r.countedTo;
      if (adjust > 0) totalIn = round2(totalIn + adjust);
      else totalOut = round2(totalOut - adjust);

      return {
        ...r,
        direction: adjust >= 0 ? "in" : "out",
        amount: Math.abs(adjust),
        balance_after: running,
      };
    }

    if (r.direction === "in") totalIn = round2(totalIn + r.amount);
    else totalOut = round2(totalOut + r.amount);

    running = round2(running + (r.direction === "in" ? r.amount : -r.amount));
    return { ...r, balance_after: running };
  });

  return { rows: ordered.reverse(), totalIn, totalOut, closing: running };
};

/** بيجيب الدرج ويتأكد إنه في نفس السنتر وشغّال */
const loadDrawer = async (db, { id, tenantId, allowInactive = false }) => {
  const drawer = await db.cashDrawer.findFirst({
    where: { id, tenant_id: tenantId },
  });
  if (!drawer) {
    const err = new Error("الدرج مش موجود في السنتر ده.");
    err.status = 404;
    throw err;
  }
  if (!drawer.is_active && !allowInactive) {
    const err = new Error(`الدرج "${drawer.name}" موقوف.`);
    err.status = 400;
    throw err;
  }
  return drawer;
};

/**
 * الرقم اللي الشاشة عرضته لسه هو هو؟
 *
 * بين ما الموظف يشوف "الدرج فيه ٣٢٠٠" ويدوس تأكيد، ممكن زميله
 * يكون قبض ١٠٠ — فيبقى أكّد رقم عمره ما شافه.
 */
const expectedMatches = (expectedSeen, expected) => {
  if (expectedSeen === undefined || expectedSeen === null) return true;
  return round2(expectedSeen) === round2(expected);
};

const expectedChangedError = (expected) => {
  const err = new Error("رصيد الدرج اتغيّر — راجع الرقم الجديد.");
  err.status = 409;
  err.code = "EXPECTED_CHANGED";
  err.expected = expected;
  return err;
};

/**
 * بيحسب المتوقع ويرفض لو اتغيّر عن اللي الشاشة شافته.
 * بيتنادى **جوه** الترانزاكشن عشان الرقم يكون لحظة الكتابة بالظبط.
 */
const resolveExpected = async (db, drawer, expectedSeen) => {
  const expected = await expectedBalance(db, drawer);
  if (!expectedMatches(expectedSeen, expected))
    throw expectedChangedError(expected);
  return expected;
};

/** بيرد 409 موحّد على الشاشة لما الرصيد يتغيّر تحت إيد المستخدم */
const sendExpectedChanged = (res, err) =>
  res.status(409).json({
    success: false,
    code: "EXPECTED_CHANGED",
    message: err.message,
    data: { expected: err.expected },
  });

/**
 * بيسجّل جرد ويحرّك رصيد الدرج للرقم اللي اتعدّ.
 * لازم يتنادى جوه transaction.
 */
const recordCount = async (
  tx,
  {
    drawer,
    tenantId,
    shiftId = null,
    userId,
    reason, // open | close | handover | manual
    expected,
    counted,
    relatedUserId = null,
    note = null,
  },
) => {
  const variance = round2(Number(counted) - Number(expected));

  const row = await tx.drawerCount.create({
    data: {
      tenant_id: tenantId,
      drawer_id: drawer.id,
      shift_id: shiftId,
      user_id: userId,
      reason,
      expected: round2(expected),
      counted: round2(counted),
      variance,
      related_user_id: relatedUserId,
      note,
    },
  });

  await tx.cashDrawer.update({
    where: { id: drawer.id },
    data: {
      last_counted_balance: row.counted,
      last_counted_at: row.counted_at,
    },
  });

  return { count: row, variance };
};

/**
 * بعد ما حد يقفل أو يعدّ على درج فيه ناس تانية شغالة:
 * كل وردية لسه مفتوحة على نفس الدرج لازم صاحبها يأكد الرصيد الجديد
 * قبل ما يكمّل شغل.
 *
 * الفلاج ده مش بس للدايالوج — هو اللي بيخلي الطلب يفضل مستني حتى لو
 * الـ SSE ضاع أو البرنامج اتقفل واتفتح.
 */
const flagOthersForAck = (tx, { drawerId, exceptShiftId = null }) =>
  tx.shift.updateMany({
    where: {
      drawer_id: drawerId,
      closed_at: null,
      ...(exceptShiftId ? { id: { not: exceptShiftId } } : {}),
    },
    data: { needs_ack: true },
  });

/** آخر جرد على الدرج — منه الدايالوج بيقول "أحمد قفل والدرج فيه ٣٢٠٠" */
const lastCountOf = (db, drawerId) =>
  db.drawerCount.findFirst({
    where: { drawer_id: drawerId },
    orderBy: { counted_at: "desc" },
    include: {
      user: USER_PICK,
      related_user: USER_PICK,
    },
  });

/**
 * الدرج فيه كفاية للمبلغ ده؟
 *
 * ⚠ قبل كده ماكانش فيه أي فحص: سحب ١٥١٥١ ج من درج فيه ١٣٤٩٩ ج
 *   كان بيعدّي عادي، والدرج يروح بالسالب. ومن ساعتها كل رقم
 *   بعده مبني على فلوس ماكانتش موجودة — الإيرادات والأرباح
 *   والتقارير كلها.
 *
 *   الدفتر هو اللي بيحدد المسموح يخرج. ولو الدرج فيه أكتر من
 *   اللي الدفتر حاسبه فعلاً، الطريق الصح جرد — بيتسجّل باسم
 *   اللي عدّه وبيسيب أثر — مش إننا نسيب السحب يعدّي من غير حساب.
 *
 * بيرمي `INSUFFICIENT_DRAWER` ومعاه الرصيد عشان الشاشة تعرضه.
 */
const assertDrawerHasEnough = async (db, drawer, amount) => {
  const needed = round2(Number(amount) || 0);
  if (needed <= 0) return;

  const available = await expectedBalance(db, drawer);
  if (needed <= available) return;

  const err = new Error(
    `الدرج "${drawer.name}" فيه ${available} ج بس، ومش كفاية ` +
      `لـ ${needed}.`,
  );
  err.status = 400;
  err.code = "INSUFFICIENT_DRAWER";
  err.data = {
    drawer: { id: drawer.id, name: drawer.name },
    available,
    requested: needed,
    shortfall: round2(needed - available),
  };
  throw err;
};

module.exports = {
  round2,
  assertDrawerHasEnough,
  expectedBalance,
  drawerLedger,
  drawerTotals,
  loadDrawer,
  expectedMatches,
  expectedChangedError,
  resolveExpected,
  sendExpectedChanged,
  recordCount,
  flagOthersForAck,
  lastCountOf,
};
