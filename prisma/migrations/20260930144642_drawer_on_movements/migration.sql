// scripts/backfill-drawers.js
//
// بيربط الحركات المالية القديمة بدرجها. بيتشغّل مرة واحدة بعد
// migration الـ drawer_id، وآمن لو اتشغّل أكتر من مرة (بيشتغل على
// الصفوف اللي `drawer_id` بتاعها null بس).
//
//   node scripts/backfill-drawers.js

const prisma = require("../src/config/db");

const MODELS = [
  ["payment", "دفعات"],
  ["expense", "مصروفات"],
  ["cashTransaction", "حركات درج"],
];

(async () => {
  const done = { payment: 0, expense: 0, cashTransaction: 0 };

  // ── ١) من الوردية ────────────────────────────────────────
  const shifts = await prisma.shift.findMany({
    where: { drawer_id: { not: null } },
    select: { id: true, drawer_id: true },
  });

  for (const s of shifts) {
    for (const [model] of MODELS) {
      const r = await prisma[model].updateMany({
        where: { shift_id: s.id, drawer_id: null },
        data: { drawer_id: s.drawer_id },
      });
      done[model] += r.count;
    }
  }
  console.log("[١] من الوردية:", done);

  // ── ٢) من الفرع — بس لو الفرع فيه درج شغّال واحد ─────────
  //
  // ⚠ لو الفرع فيه أكتر من درج، مفيش طريقة نعرف بيها الفلوس دخلت
  //   أنهي صندوق. التخمين هنا أسوأ من الفراغ — هيطلّع فرق وهمي في
  //   درج والتاني ينقص.
  const fromBranch = { payment: 0, expense: 0, cashTransaction: 0 };
  const skipped = [];

  const branches = await prisma.branch.findMany({
    select: { id: true, name: true },
  });

  for (const b of branches) {
    const drawers = await prisma.cashDrawer.findMany({
      where: { branch_id: b.id, is_active: true },
      select: { id: true },
    });

    if (drawers.length !== 1) {
      const pending = await Promise.all(
        MODELS.map(([m]) =>
          prisma[m].count({ where: { branch_id: b.id, drawer_id: null } })
        )
      );
      const total = pending.reduce((a, n) => a + n, 0);
      if (total > 0) {
        skipped.push({ branch: b.name, drawers: drawers.length, rows: total });
      }
      continue;
    }

    for (const [model] of MODELS) {
      const r = await prisma[model].updateMany({
        where: { branch_id: b.id, drawer_id: null },
        data: { drawer_id: drawers[0].id },
      });
      fromBranch[model] += r.count;
    }
  }
  console.log("[٢] من الفرع:", fromBranch);

  // ── ٣) نوع الدفعة ───────────────────────────────────────
  const wallet = await prisma.payment.updateMany({
    where: {
      kind: "fee",
      OR: [{ notes: "شحن محفظة" }, { receipt_number: { startsWith: "W-" } }],
    },
    data: { kind: "wallet_topup" },
  });
  console.log("[٣] اتعلّمت كشحن محفظة:", wallet.count);

  // ── النتيجة ─────────────────────────────────────────────
  const left = await Promise.all(
    MODELS.map(([m]) => prisma[m].count({ where: { drawer_id: null } }))
  );

  console.log("\nلسه من غير درج:", {
    payments: left[0],
    expenses: left[1],
    cash: left[2],
  });

  if (skipped.length) {
    console.log(
      "\n⚠ الفروع دي فيها أكتر من درج شغّال، فالحركات القديمة بتاعتها" +
        " سيبتها من غير درج عن قصد — حدّدها بإيدك أو اعمل جرد للدروج:"
    );
    console.table(skipped);
  }

  if (left.every((n) => n === 0)) console.log("\n✓ تمام");

  process.exit(0);
})().catch((e) => {
  console.error("فشل:", e.message);
  process.exit(1);
});