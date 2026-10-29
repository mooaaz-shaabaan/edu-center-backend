-- «الامتحانات» بقت خدمة تتباع للسنتر زي الباقي.
--
-- ⚠ قبل كده كانت مفتوحة لكل السناتر (مش في TENANT_FEATURES
--   أصلاً، و exams.routes على requireRole لوحده). فلو سبنا
--   العمود زي ما هو، كل سنتر شغّال دلوقتي هيفقد الامتحانات
--   فجأة — والسبب تغيير في الكود مش قرار من صاحب النظام.
--
--   فبنضيفها للي عندهم بالفعل. منعها بقى قرار صريح بعد كده.
UPDATE "tenants"
SET "features" =
  CASE
    WHEN "features" IS NULL OR btrim("features") = '' THEN 'exams'
    ELSE "features" || ',exams'
  END
WHERE ('exams' <> ALL (string_to_array(coalesce("features", ''), ',')));
