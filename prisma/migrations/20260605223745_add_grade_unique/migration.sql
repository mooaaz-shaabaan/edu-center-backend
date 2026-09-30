/*
  Warnings:

  - A unique constraint covering the columns `[exam_id,student_id]` on the table `student_grades` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "student_grades_exam_id_student_id_key" ON "student_grades"("exam_id", "student_id");
