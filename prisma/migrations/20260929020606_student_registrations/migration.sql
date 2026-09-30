-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "registration_links" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "rotated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "uses_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_registrations" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "link_id" INTEGER,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "parent_phone" TEXT NOT NULL,
    "alt_phone" TEXT,
    "notes" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'pending',
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "student_id" INTEGER,
    "submitted_ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_registration_courses" (
    "id" SERIAL NOT NULL,
    "registration_id" INTEGER NOT NULL,
    "course_id" INTEGER NOT NULL,

    CONSTRAINT "student_registration_courses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registration_links_token_key" ON "registration_links"("token");

-- CreateIndex
CREATE INDEX "registration_links_tenant_id_idx" ON "registration_links"("tenant_id");

-- CreateIndex
CREATE INDEX "registration_links_created_by_idx" ON "registration_links"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "registration_links_branch_id_key" ON "registration_links"("branch_id");

-- CreateIndex
CREATE INDEX "student_registrations_tenant_id_branch_id_status_idx" ON "student_registrations"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "student_registrations_tenant_id_phone_idx" ON "student_registrations"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "student_registrations_link_id_idx" ON "student_registrations"("link_id");

-- CreateIndex
CREATE INDEX "student_registrations_reviewed_by_idx" ON "student_registrations"("reviewed_by");

-- CreateIndex
CREATE INDEX "student_registrations_student_id_idx" ON "student_registrations"("student_id");

-- CreateIndex
CREATE INDEX "student_registration_courses_course_id_idx" ON "student_registration_courses"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_registration_courses_registration_id_course_id_key" ON "student_registration_courses"("registration_id", "course_id");

-- AddForeignKey
ALTER TABLE "registration_links" ADD CONSTRAINT "registration_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_links" ADD CONSTRAINT "registration_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_links" ADD CONSTRAINT "registration_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registrations" ADD CONSTRAINT "student_registrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registrations" ADD CONSTRAINT "student_registrations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registrations" ADD CONSTRAINT "student_registrations_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "registration_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registrations" ADD CONSTRAINT "student_registrations_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registrations" ADD CONSTRAINT "student_registrations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registration_courses" ADD CONSTRAINT "student_registration_courses_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "student_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_registration_courses" ADD CONSTRAINT "student_registration_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
