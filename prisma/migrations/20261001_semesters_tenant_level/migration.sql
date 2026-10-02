-- المراحل الدراسية تبقى على مستوى السنتر بدل الفرع
--
-- ⚠ العملية دي مش رجوع: الصفوف المكررة عبر الفروع بتتدمج في صف
--   واحد، والمكرر بيتمسح. خد backup الأول.
--
-- المنطق: لكل سنتر، الصفوف اللي ليها نفس الاسم والسنة (بعد تجاهل
-- حالة الحروف والمسافات الزايدة) بتبقى صف واحد — أقدمهم id. كل
-- اشتراك وكل طلب تسجيل بيتنقل للصف ده قبل ما المكرر يتشال.
--
-- ⚠ الدمج متكرر كـ CTE في كل جملة بدل جدول مؤقت. الجدول المؤقت
--   كان بيفترض إن الملف كله بيتنفّذ في نفس الاتصال والـ transaction
--   — افتراض صحيح مع Prisma دلوقتي بس مش مضمون، ولو اتكسر كان
--   نص الهجرة هيعدّي والباقي يقع على جدول مش موجود.

-- ── ١) لو أي نسخة من الصف كانت شغّالة، الناجي يبقى شغّال ───
-- من غير الخطوة دي صف موقوف في فرع ممكن يبلع نسخة شغّالة في فرع تاني
WITH m AS (
  SELECT
    id AS old_id,
    MIN(id) OVER (
      PARTITION BY tenant_id, btrim(lower(name)), btrim(lower(year))
    ) AS keep_id,
    is_active
  FROM "semesters"
)
UPDATE "semesters" k
SET is_active = TRUE
FROM m
WHERE k.id = m.keep_id
  AND m.is_active
  AND NOT k.is_active;

-- ── ٢) نقل الاشتراكات للصف الناجي ──────────────────────────
WITH m AS (
  SELECT
    id AS old_id,
    MIN(id) OVER (
      PARTITION BY tenant_id, btrim(lower(name)), btrim(lower(year))
    ) AS keep_id
  FROM "semesters"
)
UPDATE "enrollments" e
SET semester_id = m.keep_id
FROM m
WHERE e.semester_id = m.old_id
  AND m.keep_id <> m.old_id;

-- ── ٣) ونقل طلبات التسجيل ──────────────────────────────────
WITH m AS (
  SELECT
    id AS old_id,
    MIN(id) OVER (
      PARTITION BY tenant_id, btrim(lower(name)), btrim(lower(year))
    ) AS keep_id
  FROM "semesters"
)
UPDATE "student_registrations" r
SET semester_id = m.keep_id
FROM m
WHERE r.semester_id = m.old_id
  AND m.keep_id <> m.old_id;

-- ── ٤) حذف المكرر — بعد ما كل المراجع اتنقلت ───────────────
WITH m AS (
  SELECT
    id AS old_id,
    MIN(id) OVER (
      PARTITION BY tenant_id, btrim(lower(name)), btrim(lower(year))
    ) AS keep_id
  FROM "semesters"
)
DELETE FROM "semesters" s
USING m
WHERE s.id = m.old_id
  AND m.keep_id <> m.old_id;

-- ── ٥) إسقاط الربط بالفرع ──────────────────────────────────
-- `DROP COLUMN` بيشيل الـ FK والـ index بتوعه لوحده، بس بنسمّيهم
-- صراحةً عشان لو اتسمّوا بأسماء تانية في قاعدة قديمة
DROP INDEX IF EXISTS "semesters_tenant_id_branch_id_idx";
ALTER TABLE "semesters" DROP CONSTRAINT IF EXISTS "semesters_branch_id_fkey";
ALTER TABLE "semesters" DROP COLUMN IF EXISTS "branch_id";

-- ── ٦) منع التكرار من دلوقتي ───────────────────────────────
CREATE UNIQUE INDEX "semesters_tenant_id_name_year_key"
  ON "semesters" ("tenant_id", "name", "year");
