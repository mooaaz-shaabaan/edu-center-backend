-- كل حركة فلوس بتتربط بدرجها، مش بالوردية بس.
--
-- السبب: الأونر والأدمن بيتعاملوا بفلوس من غير وردية أصلاً، فلو
-- الدرج مشتق من الوردية بتبقى فيه حركات من غير صندوق معروف —
-- وأول جرد بعدها بيطلّع فرق باسم حد مالوش ذنب.
--
-- ⚠ العمود `NULL` بقصد: الحركات القديمة مالهاش درج معروف.
--   `scripts/backfill-drawers.js` بيملاها بعد الهجرة دي.
--
-- ⚠ الملف ده كان **اتكتب فيه بالغلط** محتوى
--   `scripts/backfill-drawers.js` (جافاسكريبت مكان الـSQL).
--   الداتابيز اللي الهجرة اتسجّلت عليها قبل الغلطة ماحستش بحاجة،
--   لكن أي داتابيز جديدة كانت بتقف هنا:
--       ERROR: syntax error at or near "//"
--   يعني أول نشر على سيرفر جديد كان هيفشل. السكريبت نفسه موجود
--   في `scripts/` زي ما هو — مفيش حاجة ضاعت.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "drawer_id" INTEGER;
ALTER TABLE "expenses" ADD COLUMN "drawer_id" INTEGER;
ALTER TABLE "cash_transactions" ADD COLUMN "drawer_id" INTEGER;

-- CreateIndex
CREATE INDEX "payments_drawer_id_created_at_idx" ON "payments"("drawer_id", "created_at");
CREATE INDEX "expenses_drawer_id_created_at_idx" ON "expenses"("drawer_id", "created_at");
CREATE INDEX "cash_transactions_drawer_id_type_created_at_idx" ON "cash_transactions"("drawer_id", "type", "created_at");

-- AddForeignKey
-- الدرج لو اتمسح، الحركة بتفضل موجودة من غير درج — الفلوس اتحركت
-- فعلاً، فمينفعش تختفي من السجل.
ALTER TABLE "payments" ADD CONSTRAINT "payments_drawer_id_fkey" FOREIGN KEY ("drawer_id") REFERENCES "cash_drawers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_drawer_id_fkey" FOREIGN KEY ("drawer_id") REFERENCES "cash_drawers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_drawer_id_fkey" FOREIGN KEY ("drawer_id") REFERENCES "cash_drawers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
