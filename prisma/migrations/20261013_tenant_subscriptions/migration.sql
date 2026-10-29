-- اشتراكات السناتر: رقم واتس · فيتشرز مدفوعة · تاريخ انتهاء
--
-- ⚠ آمنة على البيانات الموجودة:
--     features             → كل الفيتشرز، فالسناتر الحالية مايتغيّرش
--                            عندها حاجة
--     subscription_ends_at → NULL = مفتوح بلا نهاية، فمفيش سنتر
--                            بيتقفل بسبب الهجرة دي
--     is_trial             → false، السناتر الحالية مش تجريبية

ALTER TABLE "tenants" ADD COLUMN "phone" TEXT;

ALTER TABLE "tenants" ADD COLUMN "features" TEXT NOT NULL
  DEFAULT 'students,registrations,attendance,courses,semesters,schedules,payments,expenses,reports,shifts,users,branches';

ALTER TABLE "tenants" ADD COLUMN "subscription_ends_at" TIMESTAMP(3);

ALTER TABLE "tenants" ADD COLUMN "is_trial" BOOLEAN NOT NULL DEFAULT false;

-- الكرون بيدوّر كل يوم على اللي خلص اشتراكه — الفهرس بيخليها
-- قراءة واحدة بدل scan على الجدول كله
CREATE INDEX "tenants_subscription_ends_at_idx"
  ON "tenants" ("subscription_ends_at");
