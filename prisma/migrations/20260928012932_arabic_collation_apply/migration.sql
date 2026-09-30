DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'ar-x-icu') THEN
    RAISE NOTICE 'ar-x-icu not available — skipped';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE "students" ALTER COLUMN "name" TYPE text COLLATE "ar-x-icu"';
  EXECUTE 'ALTER TABLE "courses"  ALTER COLUMN "name" TYPE text COLLATE "ar-x-icu"';
  EXECUTE 'ALTER TABLE "users"    ALTER COLUMN "name" TYPE text COLLATE "ar-x-icu"';
  EXECUTE 'ALTER TABLE "branches" ALTER COLUMN "name" TYPE text COLLATE "ar-x-icu"';
END $$;