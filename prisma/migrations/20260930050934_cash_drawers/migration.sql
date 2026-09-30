-- CreateEnum
CREATE TYPE "DrawerCountReason" AS ENUM ('open', 'close', 'handover', 'manual');

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "closing_counted" DECIMAL(10,2),
ADD COLUMN     "drawer_id" INTEGER,
ADD COLUMN     "needs_ack" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "opening_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "variance" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "cash_drawers" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_counted_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "last_counted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'synced',

    CONSTRAINT "cash_drawers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawer_counts" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "drawer_id" INTEGER NOT NULL,
    "shift_id" INTEGER,
    "user_id" INTEGER NOT NULL,
    "reason" "DrawerCountReason" NOT NULL,
    "expected" DECIMAL(10,2) NOT NULL,
    "counted" DECIMAL(10,2) NOT NULL,
    "variance" DECIMAL(10,2) NOT NULL,
    "related_user_id" INTEGER,
    "note" TEXT,
    "counted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawer_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_drawers_tenant_id_idx" ON "cash_drawers"("tenant_id");

-- CreateIndex
CREATE INDEX "cash_drawers_tenant_id_branch_id_is_active_idx" ON "cash_drawers"("tenant_id", "branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "cash_drawers_branch_id_name_key" ON "cash_drawers"("branch_id", "name");

-- CreateIndex
CREATE INDEX "drawer_counts_tenant_id_idx" ON "drawer_counts"("tenant_id");

-- CreateIndex
CREATE INDEX "drawer_counts_drawer_id_counted_at_idx" ON "drawer_counts"("drawer_id", "counted_at");

-- CreateIndex
CREATE INDEX "drawer_counts_shift_id_idx" ON "drawer_counts"("shift_id");

-- CreateIndex
CREATE INDEX "drawer_counts_user_id_idx" ON "drawer_counts"("user_id");

-- CreateIndex
CREATE INDEX "drawer_counts_related_user_id_idx" ON "drawer_counts"("related_user_id");

-- CreateIndex
CREATE INDEX "cash_transactions_shift_id_type_created_at_idx" ON "cash_transactions"("shift_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "expenses_shift_id_created_at_idx" ON "expenses"("shift_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_shift_id_created_at_idx" ON "payments"("shift_id", "created_at");

-- CreateIndex
CREATE INDEX "shifts_drawer_id_closed_at_idx" ON "shifts"("drawer_id", "closed_at");

-- AddForeignKey
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_drawer_id_fkey" FOREIGN KEY ("drawer_id") REFERENCES "cash_drawers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawer_counts" ADD CONSTRAINT "drawer_counts_related_user_id_fkey" FOREIGN KEY ("related_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_drawer_id_fkey" FOREIGN KEY ("drawer_id") REFERENCES "cash_drawers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
