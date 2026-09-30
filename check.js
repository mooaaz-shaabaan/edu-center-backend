// check.js — مؤقت للتشخيص، امسحه بعد ما تخلص
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  console.log("\n══ آخر العمليات المالية ══");
  console.table(await prisma.$queryRawUnsafe(`
    SELECT 'payment' AS type, id, amount::float8 AS amount, shift_id, created_by, paid_at AS at FROM payments
    UNION ALL
    SELECT 'cash_' || type::text, id, amount::float8, shift_id, created_by, created_at FROM cash_transactions
    UNION ALL
    SELECT 'expense', id, amount::float8, shift_id, created_by, expense_date FROM expenses
    ORDER BY at DESC
    LIMIT 20
  `));

  console.log("\n══ آخر الحضور ══");
  console.table(await prisma.$queryRawUnsafe(`
    SELECT id, student_id, shift_id, cash_paid, wallet_debited, date
    FROM attendance ORDER BY date DESC LIMIT 10
  `));

  console.log("\n══ آخر الجلسات ══");
  console.table(await prisma.$queryRawUnsafe(`
    SELECT id, user_id, branch_id, opened_at, closed_at
    FROM shifts ORDER BY opened_at DESC LIMIT 5
  `));

  await prisma.$disconnect();
})();