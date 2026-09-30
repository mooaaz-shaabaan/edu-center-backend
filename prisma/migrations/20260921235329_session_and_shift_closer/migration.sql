-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "closed_by" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_seen_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "shifts_closed_by_idx" ON "shifts"("closed_by");

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
