// src/utils/portalCode.js
// بيولّد كود 6 أرقام للبورتال
const crypto = require("crypto");

/// ⚠ `Math.random` مش عشوائي كفاية لكود بيفتح بيانات طالب —
///   من كام كود اتولّدوا ورا بعض ينفع يتوقّع اللي جاي.
const generatePortalCode = () =>
  String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000));

/**
 * كود مضمون إنه مش مستخدم.
 *
 * ⚠ `portal_code` عمود @unique على الداتابيز كلها — مش على السنتر بس.
 *   الاحتمالات ٩٠٠ ألف، فعند ١٠٠٠ طالب فرصة التصادم بتوصل ٤٠٪.
 *   من غير الفحص ده الـ create بيرمي P2002 فجأة على طالب عشوائي
 *   والموظف مش هيفهم السبب.
 */
const generateUniquePortalCode = async (prisma, tries = 15) => {
  for (let i = 0; i < tries; i++) {
    const code = generatePortalCode();
    const taken = await prisma.student.findUnique({
      where: { portal_code: code },
      select: { id: true },
    });
    if (!taken) return code;
  }
  const err = new Error("تعذّر توليد كود جديد — جرّب تاني.");
  err.status = 503;
  throw err;
};

module.exports = { generatePortalCode, generateUniquePortalCode };