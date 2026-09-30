-- CreateEnum
CREATE TYPE "CoursePriceMode" AS ENUM ('unified', 'per_branch');

-- AlterTable
ALTER TABLE "course_schedules" ADD COLUMN     "branch_id" INTEGER;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "price_mode" "CoursePriceMode" NOT NULL DEFAULT 'unified';

-- CreateTable
CREATE TABLE "course_branches" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "course_id" INTEGER NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'synced',

    CONSTRAINT "course_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_branches_tenant_id_branch_id_idx" ON "course_branches"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "course_branches_branch_id_idx" ON "course_branches"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_branches_course_id_branch_id_key" ON "course_branches"("course_id", "branch_id");

-- CreateIndex
CREATE INDEX "course_schedules_branch_id_idx" ON "course_schedules"("branch_id");

-- AddForeignKey
ALTER TABLE "course_branches" ADD CONSTRAINT "course_branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_branches" ADD CONSTRAINT "course_branches_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_branches" ADD CONSTRAINT "course_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_schedules" ADD CONSTRAINT "course_schedules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
