-- DropForeignKey
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_course_id_fkey";

-- AlterTable
ALTER TABLE "enrollments" ALTER COLUMN "course_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
