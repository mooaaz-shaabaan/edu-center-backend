/*
  Warnings:

  - A unique constraint covering the columns `[student_id,course_id,attendance_day,session_no]` on the table `attendance` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "attendance_student_id_course_id_attendance_day_key";

-- AlterTable
ALTER TABLE "attendance" ADD COLUMN     "session_no" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "attendance_student_id_course_id_attendance_day_session_no_key" ON "attendance"("student_id", "course_id", "attendance_day", "session_no");
