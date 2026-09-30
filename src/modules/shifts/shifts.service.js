// src/modules/shifts/shifts.service.js
// منطق قفل الشيفت — مشترك بين قفل الشيفت والخروج الإجباري

const {
  round2,
  resolveExpected,
  recordCount,
  flagOthersForAck,
} = require("../../core/drawerBalance");

// الـ include المشترك: الموظف (ومعاه آخر نبضة) + الفرع + الدرج + مين قفل
const SHIFT_INCLUDE = {
  user: { select: { id: true, name: true, role: true, last_seen_at: true } },
  branch: { select: { id: true, name: true } },
  drawer: { select: { id: true, name: true } },
  closer: { select: { id: true, name: true, role: true } },
};

/**
 * بيحسب إجماليات الشيفت ويقفله — جوه transaction.
 *
 * closedBy  = اليوزر اللي قفل (الموظف نفسه أو مدير)
 * drawerCtx = { drawer, tenantId, counted, expectedSeen } لما يكون فيه
 *             عدّ للدرج. null = قفل من غير جرد (الورديات القديمة اللي
 *             مالهاش درج، والقفل الإجباري وقت فتح وردية جديدة —
 *             ساعتها الدرج مابيتحركش ورصيده بيفضل مستني أول جرد).
 */
const closeShiftWithTotals = async (tx, shift, closedBy, drawerCtx = null) => {
  const [payments, expenses, cashIn, cashOut, attendanceCount] =
    await Promise.all([
      tx.payment.aggregate({
        where: { shift_id: shift.id },
        _sum: { amount: true },
      }),
      tx.expense.aggregate({
        where: { shift_id: shift.id },
        _sum: { amount: true },
      }),
      tx.cashTransaction.aggregate({
        where: { shift_id: shift.id, type: "deposit" },
        _sum: { amount: true },
      }),
      tx.cashTransaction.aggregate({
        where: { shift_id: shift.id, type: "withdrawal" },
        _sum: { amount: true },
      }),
      tx.attendance.count({
        // حاضر + متأخر = حضر فعلاً (الغياب بس اللي مايتعدش)
        where: { shift_id: shift.id, status: { in: ["present", "late"] } },
      }),
    ]);

  const totalIncome =
    Number(payments._sum.amount || 0) + Number(cashIn._sum.amount || 0);
  const totalExpenses =
    Number(expenses._sum.amount || 0) + Number(cashOut._sum.amount || 0);
  const netTotal = totalIncome - totalExpenses;

  // updateMany بشرط closed_at: null — يمنع القفل مرتين لو حصل ضغطتين.
  // بيتعمل **الأول** عشان ما نسجّلش جرد على وردية مقفولة أصلاً.
  const updateResult = await tx.shift.updateMany({
    where: { id: shift.id, closed_at: null },
    data: {
      closed_at: new Date(),
      closed_by: closedBy ?? null,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net_total: netTotal,
      sync_status: "synced",
      needs_ack: false, // خلاص بيقفل — مفيش تأكيد مستني
    },
  });

  if (updateResult.count === 0) {
    const err = new Error("Shift was already closed.");
    err.status = 409;
    throw err;
  }

  // ── جرد الدرج ────────────────────────────────────────────
  let countRow = null;
  let variance = null;
  let expected = null;

  if (drawerCtx?.drawer) {
    const { drawer, tenantId, counted, expectedSeen } = drawerCtx;

    // الرقم بيتحسب جوه الترانزاكشن عشان يكون لحظة الكتابة بالظبط
    expected = await resolveExpected(tx, drawer, expectedSeen);

    const rec = await recordCount(tx, {
      drawer,
      tenantId,
      shiftId: shift.id,
      userId: closedBy,
      reason: "close",
      expected,
      counted,
      // مدير قفل لموظف؟ الاسمين الاتنين يتسجّلوا
      relatedUserId: shift.user_id !== closedBy ? shift.user_id : null,
    });

    countRow = rec.count;
    variance = rec.variance;

    await tx.shift.update({
      where: { id: shift.id },
      data: { closing_counted: round2(counted), variance },
    });

    // اللي لسه شغال على نفس الدرج لازم يأكد الرصيد الجديد
    await flagOthersForAck(tx, {
      drawerId: drawer.id,
      exceptShiftId: shift.id,
    });
  }

  const closed = await tx.shift.findUnique({
    where: { id: shift.id },
    include: SHIFT_INCLUDE,
  });

  return {
    shift: closed,
    report: {
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net_total: netTotal,
      students_attended: attendanceCount,
      // ← الجرد: null لو الوردية اتقفلت من غير عدّ
      opening_balance: Number(closed?.opening_balance ?? 0),
      expected_close: expected,
      counted: countRow ? Number(countRow.counted) : null,
      variance,
    },
    count: countRow,
  };
};

module.exports = { SHIFT_INCLUDE, closeShiftWithTotals };
