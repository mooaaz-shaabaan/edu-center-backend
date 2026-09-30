-- شغّل ده بعد `npx prisma migrate dev --name exams_rework`
-- وقبل ما تمسح عمود max_grade.
--
-- ⚠ لو Prisma عمل الـ migration ومسح max_grade في نفس الخطوة،
--   اعمل الـ migration بـ --create-only، ضيف السطور دي جوه ملف
--   الـ migration قبل سطر DROP COLUMN، وبعدين شغّل prisma migrate dev.

-- ١) الدرجة العظمى للامتحان = أكبر max_grade مسجّلة في درجاته
UPDATE "exams" e
SET "total_marks" = COALESCE(
  (SELECT MAX(g."max_grade") FROM "student_grades" g WHERE g."exam_id" = e."id"),
  100
);

-- ٢) فرع الامتحان = فرع المادة (لو المادة لسه مربوطة بفرع واحد)
UPDATE "exams" e
SET "branch_id" = c."branch_id"
FROM "courses" c
WHERE e."course_id" = c."id" AND e."branch_id" IS NULL;

-- ٣) الدرجات الفاضية = لسه ماتصححتش، مش غياب.
--    سيبها graded بـ grade = NULL؛ لو عايز تعتبرها غياب:
-- UPDATE "student_grades" SET "status" = 'absent' WHERE "grade" IS NULL;

-- ٤) تأكد إن مفيش درجة أكبر من الدرجة العظمى بعد التوحيد
SELECT e."id", e."title", e."total_marks", COUNT(g."id") AS over_max
FROM "exams" e
JOIN "student_grades" g ON g."exam_id" = e."id"
WHERE g."grade" > e."total_marks"
GROUP BY e."id", e."title", e."total_marks";
