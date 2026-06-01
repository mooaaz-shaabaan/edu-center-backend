-- DropForeignKey
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_student_id_fkey";

-- DropForeignKey
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_student_id_fkey";

-- DropForeignKey
ALTER TABLE "installments" DROP CONSTRAINT "installments_student_id_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_student_id_fkey";

-- DropForeignKey
ALTER TABLE "student_grades" DROP CONSTRAINT "student_grades_student_id_fkey";

-- AlterTable
ALTER TABLE "attendance" ALTER COLUMN "student_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "enrollments" ALTER COLUMN "student_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "installments" ALTER COLUMN "student_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "student_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "student_grades" ALTER COLUMN "student_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_grades" ADD CONSTRAINT "student_grades_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
