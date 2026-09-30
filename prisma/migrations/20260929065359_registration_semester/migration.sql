-- AlterTable
ALTER TABLE "student_registrations" ADD COLUMN     "semester_id" INTEGER;

-- CreateIndex
CREATE INDEX "student_registrations_semester_id_idx" ON "student_registrations"("semester_id");

-- AddForeignKey
ALTER TABLE "student_registrations" ADD CONSTRAINT "student_registrations_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
