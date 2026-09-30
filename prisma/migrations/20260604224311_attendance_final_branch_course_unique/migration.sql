/*
  Warnings:

  - A unique constraint covering the columns `[student_id,course_id,attendance_day]` on the table `attendance` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `attendance_day` to the `attendance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `branch_id` to the `attendance` table without a default value. This is not possible if the table is not empty.
  - Made the column `course_id` on table `attendance` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_course_id_fkey";

-- AlterTable
ALTER TABLE "attendance" ADD COLUMN     "attendance_day" DATE NOT NULL,
ADD COLUMN     "branch_id" INTEGER NOT NULL,
ADD COLUMN     "cash_paid" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "wallet_debited" DOUBLE PRECISION DEFAULT 0,
ALTER COLUMN "course_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "attendance_branch_id_idx" ON "attendance"("branch_id");

-- CreateIndex
CREATE INDEX "attendance_date_idx" ON "attendance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_student_id_course_id_attendance_day_key" ON "attendance"("student_id", "course_id", "attendance_day");

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
