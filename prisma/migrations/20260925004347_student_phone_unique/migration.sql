/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,phone]` on the table `students` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "students_tenant_id_name_phone_key";

-- CreateIndex
CREATE UNIQUE INDEX "students_tenant_id_phone_key" ON "students"("tenant_id", "phone");
