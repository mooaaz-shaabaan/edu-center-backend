/*
  Warnings:

  - You are about to drop the column `max_grade` on the `student_grades` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ExamType" AS ENUM ('weekly', 'monthly', 'term', 'final', 'other');

-- CreateEnum
CREATE TYPE "GradeStatus" AS ENUM ('graded', 'absent', 'excused');

-- DropForeignKey
ALTER TABLE "student_grades" DROP CONSTRAINT "student_grades_exam_id_fkey";

-- AlterTable
ALTER TABLE "exams" ADD COLUMN     "branch_id" INTEGER,
ADD COLUMN     "pass_marks" DECIMAL(5,2),
ADD COLUMN     "total_marks" DECIMAL(5,2) NOT NULL DEFAULT 100,
ADD COLUMN     "type" "ExamType" NOT NULL DEFAULT 'monthly';

-- ══════════════════════════════════════════════════════════
-- Backfill (مضاف يدوياً) — لازم قبل مسح max_grade
-- ══════════════════════════════════════════════════════════

-- الدرجة العظمى للامتحان = أكبر max_grade مسجّلة في درجاته
UPDATE "exams" e
SET "total_marks" = COALESCE(
  (SELECT MAX(g."max_grade") FROM "student_grades" g WHERE g."exam_id" = e."id"),
  100
);

-- فرع الامتحان = فرع المادة
UPDATE "exams" e
SET "branch_id" = c."branch_id"
FROM "courses" c
WHERE e."course_id" = c."id" AND e."branch_id" IS NULL;

-- ══════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "student_grades" DROP COLUMN "max_grade",
ADD COLUMN     "status" "GradeStatus" NOT NULL DEFAULT 'graded';

-- CreateIndex
CREATE INDEX "exams_branch_id_idx" ON "exams"("branch_id");

-- CreateIndex
CREATE INDEX "exams_tenant_id_exam_date_idx" ON "exams"("tenant_id", "exam_date");

-- AddForeignKey
ALTER TABLE "student_grades" ADD CONSTRAINT "student_grades_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
