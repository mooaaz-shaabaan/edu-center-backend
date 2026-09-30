/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,receipt_number]` on the table `payments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email_domain]` on the table `tenants` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "attendance_date_idx";

-- DropIndex
DROP INDEX "payments_receipt_number_key";

-- CreateIndex
CREATE INDEX "attendance_tenant_id_branch_id_attendance_day_idx" ON "attendance"("tenant_id", "branch_id", "attendance_day");

-- CreateIndex
CREATE INDEX "attendance_tenant_id_course_id_attendance_day_idx" ON "attendance"("tenant_id", "course_id", "attendance_day");

-- CreateIndex
CREATE INDEX "attendance_shift_id_idx" ON "attendance"("shift_id");

-- CreateIndex
CREATE INDEX "cash_transactions_tenant_id_branch_id_created_at_idx" ON "cash_transactions"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "cash_transactions_shift_id_idx" ON "cash_transactions"("shift_id");

-- CreateIndex
CREATE INDEX "cash_transactions_created_by_idx" ON "cash_transactions"("created_by");

-- CreateIndex
CREATE INDEX "courses_tenant_id_branch_id_idx" ON "courses"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "enrollments_student_id_idx" ON "enrollments"("student_id");

-- CreateIndex
CREATE INDEX "enrollments_course_id_idx" ON "enrollments"("course_id");

-- CreateIndex
CREATE INDEX "enrollments_semester_id_idx" ON "enrollments"("semester_id");

-- CreateIndex
CREATE INDEX "exams_course_id_idx" ON "exams"("course_id");

-- CreateIndex
CREATE INDEX "expenses_tenant_id_branch_id_expense_date_idx" ON "expenses"("tenant_id", "branch_id", "expense_date");

-- CreateIndex
CREATE INDEX "expenses_shift_id_idx" ON "expenses"("shift_id");

-- CreateIndex
CREATE INDEX "expenses_created_by_idx" ON "expenses"("created_by");

-- CreateIndex
CREATE INDEX "installments_student_id_idx" ON "installments"("student_id");

-- CreateIndex
CREATE INDEX "installments_enrollment_id_idx" ON "installments"("enrollment_id");

-- CreateIndex
CREATE INDEX "installments_tenant_id_status_due_date_idx" ON "installments"("tenant_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "notifications_log_student_id_idx" ON "notifications_log"("student_id");

-- CreateIndex
CREATE INDEX "notifications_log_tenant_id_sent_at_idx" ON "notifications_log"("tenant_id", "sent_at");

-- CreateIndex
CREATE INDEX "payments_tenant_id_branch_id_paid_at_idx" ON "payments"("tenant_id", "branch_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_student_id_idx" ON "payments"("student_id");

-- CreateIndex
CREATE INDEX "payments_shift_id_idx" ON "payments"("shift_id");

-- CreateIndex
CREATE INDEX "payments_created_by_idx" ON "payments"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_receipt_number_key" ON "payments"("tenant_id", "receipt_number");

-- CreateIndex
CREATE INDEX "rooms_tenant_id_branch_id_idx" ON "rooms"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "schedule_conflicts_schedule_a_id_idx" ON "schedule_conflicts"("schedule_a_id");

-- CreateIndex
CREATE INDEX "schedule_conflicts_schedule_b_id_idx" ON "schedule_conflicts"("schedule_b_id");

-- CreateIndex
CREATE INDEX "schedules_course_id_idx" ON "schedules"("course_id");

-- CreateIndex
CREATE INDEX "schedules_room_id_day_of_week_idx" ON "schedules"("room_id", "day_of_week");

-- CreateIndex
CREATE INDEX "semesters_tenant_id_branch_id_idx" ON "semesters"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "shifts_tenant_id_branch_id_closed_at_idx" ON "shifts"("tenant_id", "branch_id", "closed_at");

-- CreateIndex
CREATE INDEX "shifts_user_id_idx" ON "shifts"("user_id");

-- CreateIndex
CREATE INDEX "student_grades_student_id_idx" ON "student_grades"("student_id");

-- CreateIndex
CREATE INDEX "students_tenant_id_branch_id_idx" ON "students"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "students_tenant_id_branch_id_is_active_idx" ON "students"("tenant_id", "branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_email_domain_key" ON "tenants"("email_domain");

-- CreateIndex
CREATE INDEX "user_branch_access_granted_by_idx" ON "user_branch_access"("granted_by");

-- CreateIndex
CREATE INDEX "user_permissions_granted_by_idx" ON "user_permissions"("granted_by");

-- CreateIndex
CREATE INDEX "users_branch_id_idx" ON "users"("branch_id");
