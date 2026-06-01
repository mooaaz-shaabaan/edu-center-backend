-- AlterTable
ALTER TABLE "students" ADD COLUMN     "wallet_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "wallet_enabled" BOOLEAN NOT NULL DEFAULT false;
