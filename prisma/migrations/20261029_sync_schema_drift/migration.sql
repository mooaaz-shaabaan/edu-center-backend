-- بيلحّق الهجرات بالـschema.
--
-- ⚠ الحاجات دي كانت اتعملت على داتابيز التطوير بـ`prisma db push`
--   من غير ما تتكتب هجرة. النتيجة: الداتابيز عندك شغالة، وأي
--   داتابيز **جديدة** بتطلع ناقصة — يعني أول نشر على سيرفر كان
--   هيقوم من غير عمود `payments.kind`، وكل موديول المدفوعات
--   بيقع لأن Prisma Client بيطلبه في كل قراية.
--
-- ⚠ كل سطر هنا مكتوب عشان يعدّي على الاتنين: الداتابيز اللي
--   عندها الحاجة أصلاً (مابيعملش حاجة)، واللي لسه فاضية.

-- ── نوع الدفعة ────────────────────────────────────────────
-- بديل `notes = "شحن محفظة"` — الترتيب لازم يطابق `enum PaymentKind`
DO $$ BEGIN
  CREATE TYPE "PaymentKind" AS ENUM (
    'fee', 'wallet_topup', 'attendance', 'registration', 'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "kind" "PaymentKind" NOT NULL DEFAULT 'fee';

-- ── الفهارس ───────────────────────────────────────────────
-- فهارس `shift_id` اتشالت: الاستعلامات بقت على الدرج والسنتر مش
-- على الوردية (شوف `drawer_on_movements`).
DROP INDEX IF EXISTS "payments_shift_id_created_at_idx";
DROP INDEX IF EXISTS "expenses_shift_id_created_at_idx";
DROP INDEX IF EXISTS "cash_transactions_shift_id_type_created_at_idx";

-- سجل شحن المحفظة بيقرا بالنوع
CREATE INDEX IF NOT EXISTS "payments_tenant_id_kind_paid_at_idx"
  ON "payments"("tenant_id", "kind", "paid_at");

-- ── الامتحانات في خدمات السنتر الافتراضية ─────────────────
-- السناتر الجديدة لازم تطلع بكل الخدمات زي ما `schema.prisma` بيقول
ALTER TABLE "tenants"
  ALTER COLUMN "features" SET DEFAULT 'students,registrations,attendance,courses,semesters,exams,schedules,payments,expenses,reports,shifts,users,branches';
