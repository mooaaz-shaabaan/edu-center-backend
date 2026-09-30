/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,name,phone]` on the table `students` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "students_tenant_id_name_phone_key" ON "students"("tenant_id", "name", "phone");
