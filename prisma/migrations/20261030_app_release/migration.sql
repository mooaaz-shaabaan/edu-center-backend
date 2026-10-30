-- إعلان تحديث البرنامج — صف واحد لكل النظام.
--
-- ⚠ مش تابع لسنتر بقصد: مالك النظام بينشر نسخة، وكل السناتر
--   بتشوف نفس الإعلان. لو احتجنا بعدين نسخة لكل سنتر، بنزوّد
--   عمود `tenant_id` nullable ونخلي null = للكل.
CREATE TABLE IF NOT EXISTS "app_release" (
  "id"           INTEGER NOT NULL DEFAULT 1,
  "version"      TEXT NOT NULL,
  "download_url" TEXT NOT NULL,
  "notes"        TEXT,
  "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
  "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "app_release_pkey" PRIMARY KEY ("id")
);
