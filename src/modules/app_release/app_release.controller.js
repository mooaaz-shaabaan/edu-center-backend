// src/modules/app_release/app_release.controller.js
//
// إعلان تحديث البرنامج: مالك النظام بينشر رقم نسخة ولينك تنزيل،
// وكل السناتر بتشوفه.
//
// ⚠ استعلامات خام مش `prisma.appRelease`: الجدول اتضاف بعد آخر
//   `prisma generate`، والمولّد مابيقدرش يشتغل والسيرفر فاتح على
//   ويندوز (الملف متقفول). الصف واحد واستعلامين، فالخام هنا
//   أوضح من انتظار التوليد. لو حبيت تحوّلهم للموديل بعدين،
//   المعنى هو هو.
const prisma = require("../../config/db");

// ── GET /api/app-release ──────────────────────────────────
// لأي حد داخل — البرنامج بيسأل عند الفتح
const getRelease = async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT version, download_url, notes, is_mandatory, published_at
      FROM app_release
      WHERE id = 1
    `;

    res.json({ success: true, data: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/app-release ──────────────────────────────────
// مالك النظام بس
const setRelease = async (req, res, next) => {
  try {
    const { version, download_url, notes, is_mandatory } = req.validated.body;

    // ⚠ صف واحد بالقوة (id = 1). من غير كده كل نشر بيعمل صف
    //   جديد والبرنامج مايعرفش يقرا أنهي واحد.
    await prisma.$executeRaw`
      INSERT INTO app_release
        (id, version, download_url, notes, is_mandatory, published_at, updated_at)
      VALUES
        (1, ${version}, ${download_url}, ${notes ?? null},
         ${is_mandatory ?? false}, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        version      = EXCLUDED.version,
        download_url = EXCLUDED.download_url,
        notes        = EXCLUDED.notes,
        is_mandatory = EXCLUDED.is_mandatory,
        published_at = now(),
        updated_at   = now()
    `;

    const rows = await prisma.$queryRaw`
      SELECT version, download_url, notes, is_mandatory, published_at
      FROM app_release WHERE id = 1
    `;

    res.json({
      success: true,
      message: `اتنشر التحديث ${version} لكل السناتر.`,
      data: rows[0],
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getRelease, setRelease };
