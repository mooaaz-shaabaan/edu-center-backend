/*
  Warnings:

  - Added the required column `branch_id` to the `cash_transactions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `branch_id` to the `expenses` table without a default value. This is not possible if the table is not empty.
  - Added the required column `branch_id` to the `payments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "cash_transactions" ADD COLUMN     "branch_id" INTEGER NOT NULL,
ADD COLUMN     "created_by" INTEGER;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "branch_id" INTEGER NOT NULL,
ADD COLUMN     "created_by" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "branch_id" INTEGER NOT NULL,
ADD COLUMN     "created_by" INTEGER;

-- CreateIndex
CREATE INDEX "cash_transactions_branch_id_idx" ON "cash_transactions"("branch_id");

-- CreateIndex
CREATE INDEX "expenses_branch_id_idx" ON "expenses"("branch_id");

-- CreateIndex
CREATE INDEX "payments_branch_id_idx" ON "payments"("branch_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
