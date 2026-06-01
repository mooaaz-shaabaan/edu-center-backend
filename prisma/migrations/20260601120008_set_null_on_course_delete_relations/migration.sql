-- DropForeignKey
ALTER TABLE "exams" DROP CONSTRAINT "exams_course_id_fkey";

-- DropForeignKey
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_course_id_fkey";

-- AlterTable
ALTER TABLE "exams" ALTER COLUMN "course_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "schedules" ALTER COLUMN "course_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
