-- «الامتحانات» بقت صلاحية بتتدّي لموظف على فرع، بعد ما كانت
-- بتتباع للسنتر ومفتوحة لكل موظفيه.
--
-- ⚠ من غير السطر ده، كل الموظفين الحاليين كانوا هيصحوا يلاقوا
--   الشاشة اختفت: صفوفهم في `user_branch_access` مافيهاش الكلمة،
--   والراوتس بقت بتسأل عنها. فبندّيهم إياها عشان اللي شغّال
--   يفضل شغّال، وصاحب السنتر يشيلها بإيده من اللي مايستاهلش.
--
--   الأونر والسوبر أدمن مالهمش صفوف هنا أصلاً (وصولهم ضمني)،
--   والسنتر اللي مش مشتري الامتحانات بيفضل مقفول عليه —
--   الفحص ده فوق الصلاحية (`inTenantPlan` في rbac.js).
UPDATE "user_branch_access"
SET "features" = CASE
      WHEN "features" IS NULL OR btrim("features") = '' THEN 'exams'
      ELSE "features" || ',exams'
    END
WHERE "features" IS NULL
   OR string_to_array("features", ',') @> ARRAY['exams'] IS NOT TRUE;
