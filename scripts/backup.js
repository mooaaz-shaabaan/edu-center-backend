// scripts/backup.js
//
// نسخة احتياطية كاملة من قاعدة البيانات.
//
//   node scripts/backup.js
//
// بيعمل إيه بالترتيب:
//   1) يلاقي pg_dump المتسطّب على الجهاز
//   2) ياخد نسخة مضغوطة (صيغة custom) في مجلد backups
//   3) **يتأكد إن النسخة سليمة** بقراية فهرسها
//   4) ينسخها في المكان التاني (هارد/فلاشة/شبكة)
//   5) يمسح النسخ القديمة حسب سياسة الاحتفاظ
//   6) يكتب last-backup.json عشان البرنامج يعرف آخر مرة نجحت
//
// الإعدادات (في .env، كلها اختيارية غير DATABASE_URL):
//   BACKUP_DIR          مكان النسخ            (افتراضي: ./backups)
//   BACKUP_MIRROR_DIR   نسخة تانية على جهاز/قرص تاني
//   PG_BIN              مجلد bin بتاع بوسجرس لو ملقهوش لوحده

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// ── إعدادات ───────────────────────────────────────────────
// ⚠ المسار الافتراضي بالنسبة لمجلد المشروع مش لمكان التشغيل.
//   لو السيرفر اتسطّب كخدمة ويندوز، بيشتغل من C:\Windows\System32
//   — يعني النسخ كانت هتتكتب هناك ومحدش هيلاقيها.
//   ⚠ وكمان: `BACKUP_DIR=backups` في الـ .env مسار نسبي —
//   لازم يتحسب من مجلد المشروع مش من مكان التشغيل، وإلا نفس
//   المشكلة بترجع من باب تاني. المطلق بيتاخد زي ما هو.
const ROOT = path.join(__dirname, "..");

const resolveDir = (value, fallback) => {
  const v = (value || "").trim();
  if (!v) return fallback;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
};

const BACKUP_DIR = resolveDir(
  process.env.BACKUP_DIR,
  path.join(ROOT, "backups"),
);
const MIRROR_DIR = resolveDir(process.env.BACKUP_MIRROR_DIR, null);

// كام نسخة نحتفظ بيها:
//   كل يوم لآخر ١٤ يوم، بعدها واحدة كل أسبوع لـ ٨ أسابيع،
//   بعدها واحدة كل شهر لسنة. يعني ~٣٤ ملف على الأكثر.
const RETENTION = { dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12 };

const PREFIX = "edu-center-";
const EXT = ".dump";
const DAY_MS = 86400000;

// ── أدوات ─────────────────────────────────────────────────
const log = (...a) => console.log("[backup]", ...a);
const warn = (...a) => console.warn("[backup] ⚠", ...a);
const fail = (...a) => console.error("[backup] ✖", ...a);

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";

/** 20260930-0200 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}`
  );
}

/** بيقرا التاريخ من اسم الملف نفسه — مش من mtime.
 *  ⚠ الـ mtime بيتغيّر مع كل نسخ، فلو اعتمدنا عليه، النسخ
 *    اللي اتنقلت للفلاشة هتبان كلها "النهاردة" وسياسة الحذف
 *    تتلخبط. */
function dateFromName(name) {
  const m = name.match(
    /^edu-center-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.dump$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi);
}

/** بيشغّل أمر ويرجّع stdout — من غير shell عشان المسارات
 *  اللي فيها مسافات (C:\Program Files\...) ماتتكسرش */
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      const e = new Error(err.trim() || `exit code ${code}`);
      e.code = code;
      reject(e);
    });
  });
}

// ── تحديد مكان pg_dump ────────────────────────────────────
const isWin = os.platform() === "win32";
const exe = (n) => (isWin ? `${n}.exe` : n);

function findPgBin() {
  // ١) اللي المستخدم حدده
  if (process.env.PG_BIN) {
    const p = path.join(process.env.PG_BIN, exe("pg_dump"));
    if (fs.existsSync(p)) return process.env.PG_BIN;
    throw new Error(`PG_BIN مضبوط بس مفيش pg_dump فيه: ${process.env.PG_BIN}`);
  }

  // ٢) التسطيب العادي على ويندوز — بناخد أحدث نسخة
  //    (pg_dump لازم يكون نسخته >= نسخة السيرفر)
  if (isWin) {
    for (const root of ["C:\\Program Files\\PostgreSQL", "C:\\PostgreSQL"]) {
      if (!fs.existsSync(root)) continue;
      const versions = fs
        .readdirSync(root)
        .filter((v) => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a));
      for (const v of versions) {
        const bin = path.join(root, v, "bin");
        if (fs.existsSync(path.join(bin, exe("pg_dump")))) return bin;
      }
    }
  }

  // ٣) موجود في الـ PATH
  return null; // null = ناديه بالاسم من غير مسار
}

const tool = (bin, name) => (bin ? path.join(bin, exe(name)) : exe(name));

// ── قراية بيانات الاتصال ──────────────────────────────────
function parseDbUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL مش موجود في .env");

  const u = new URL(raw);
  return {
    host: u.hostname || "localhost",
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    // ⚠ مابيتطبعش في أي لوج — بيتبعت للعملية الابن في env بس
    password: decodeURIComponent(u.password || ""),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

// ── سياسة الاحتفاظ ────────────────────────────────────────
/** بيقسم النسخ لـ (نحتفظ / نمسح) */
function retentionPlan(files, now = Date.now()) {
  const keep = [];
  const drop = [];
  const seen = new Set();

  // الأحدث الأول — عشان كل فترة نحتفظ بأحدث نسخة فيها
  const sorted = [...files].sort((a, b) => b.date - a.date);

  for (const f of sorted) {
    const ageDays = (now - f.date.getTime()) / DAY_MS;
    let key;

    if (ageDays <= RETENTION.dailyDays) {
      key = `d:${f.name}`; // كل نسخ الفترة دي تتحفظ
    } else if (ageDays <= RETENTION.dailyDays + RETENTION.weeklyWeeks * 7) {
      key = `w:${Math.floor(f.date.getTime() / (7 * DAY_MS))}`;
    } else if (ageDays <= 31 * RETENTION.monthlyMonths) {
      key = `m:${f.date.getFullYear()}-${f.date.getMonth()}`;
    } else {
      drop.push(f);
      continue;
    }

    if (seen.has(key)) drop.push(f);
    else {
      seen.add(key);
      keep.push(f);
    }
  }

  return { keep, drop };
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(EXT))
    .map((name) => ({ name, date: dateFromName(name) }))
    .filter((f) => f.date instanceof Date && !isNaN(f.date));
}

function rotate(dir, label) {
  const { drop } = retentionPlan(listBackups(dir));
  if (drop.length === 0) return 0;

  for (const f of drop) {
    try {
      fs.unlinkSync(path.join(dir, f.name));
    } catch (e) {
      warn(`مش قادر يمسح ${f.name} من ${label}: ${e.message}`);
    }
  }
  return drop.length;
}

// ── الشغل ─────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  const db = parseDbUrl();
  const bin = findPgBin();

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // ملفات نص نسخة من مرة وقع فيها السيرفر أو انقطعت الكهربا —
  // مابتتحسبش نسخ بس بتفضل واخدة مساحة للأبد
  for (const n of fs.readdirSync(BACKUP_DIR)) {
    if (n.endsWith(".part")) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, n));
      } catch (_) {}
    }
  }

  const fileName = `${PREFIX}${stamp()}${EXT}`;
  const target = path.join(BACKUP_DIR, fileName);
  // بنكتب في ملف مؤقت وبنغيّر الاسم في الآخر — عشان لو الكهربا
  // قطعت في النص ماينفعش ملف نص نسخة يتحسب نسخة سليمة
  const tmp = target + ".part";

  log(`قاعدة البيانات: ${db.database}@${db.host}:${db.port}`);
  log(`المجلد: ${BACKUP_DIR}`);

  // ١) النسخة
  const env = db.password ? { PGPASSWORD: db.password } : {};
  await run(
    tool(bin, "pg_dump"),
    [
      "-h",
      db.host,
      "-p",
      String(db.port),
      "-U",
      db.user,
      "-d",
      db.database,
      "-Fc", // صيغة مضغوطة، وبتسمح باسترجاع جزئي
      "--no-owner", // تترجع على أي سيرفر باسم مستخدم مختلف
      "--no-privileges",
      "-f",
      tmp,
    ],
    env,
  );

  // ٢) التحقق — نسخة ما اتقرتش مرة واحدة مش نسخة
  //    pg_restore --list بيقرا الفهرس، فبيكشف الملف الناقص
  //    أو المقطوع على طول
  const toc = await run(tool(bin, "pg_restore"), ["--list", tmp], env);
  const entries = toc.split("\n").filter((l) => l && !l.startsWith(";")).length;
  if (entries < 5) {
    fs.unlinkSync(tmp);
    throw new Error("النسخة طلعت فاضية أو ناقصة — اتلغت.");
  }

  fs.renameSync(tmp, target);
  const size = fs.statSync(target).size;
  log(`✓ ${fileName} — ${mb(size)} — ${entries} عنصر`);

  // ٣) النسخة التانية
  let mirrored = false;
  if (MIRROR_DIR) {
    try {
      fs.mkdirSync(MIRROR_DIR, { recursive: true });
      const mTmp = path.join(MIRROR_DIR, fileName + ".part");
      fs.copyFileSync(target, mTmp);
      fs.renameSync(mTmp, path.join(MIRROR_DIR, fileName));
      mirrored = true;
      log(`✓ اتنسخت كمان في ${MIRROR_DIR}`);
    } catch (e) {
      // فشل النسخ التاني مايلغيش النسخة الأصلية
      warn(`النسخة التانية فشلت (${MIRROR_DIR}): ${e.message}`);
    }
  } else {
    warn(
      "مفيش BACKUP_MIRROR_DIR — النسخة على نفس الهارد بتاع القاعدة.\n" +
        "        الهارد لو باظ، القاعدة والنسخة بيروحوا مع بعض.\n" +
        "        حط مسار على قرص/فلاشة/شبكة في .env",
    );
  }

  // ٤) تنضيف القديم
  const dropped = rotate(BACKUP_DIR, "المجلد");
  if (MIRROR_DIR && mirrored) rotate(MIRROR_DIR, "النسخة التانية");
  if (dropped) log(`اتمسح ${dropped} نسخة قديمة`);

  // ٥) الحالة — عشان البرنامج يقدر يقول "آخر نسخة من ساعتين"
  const status = {
    ok: true,
    at: new Date().toISOString(),
    file: fileName,
    bytes: size,
    entries,
    mirrored,
    durationMs: Date.now() - startedAt,
    kept: listBackups(BACKUP_DIR).length,
  };
  fs.writeFileSync(
    path.join(BACKUP_DIR, "last-backup.json"),
    JSON.stringify(status, null, 2),
  );

  log(`تمام — ${((Date.now() - startedAt) / 1000).toFixed(1)} ثانية`);
  return status;
}

// ── التشغيل المباشر ───────────────────────────────────────
if (require.main === module) {
  main().catch((e) => {
    fail(e.message);

    // نسجّل الفشل كمان — السكوت أخطر من الخطأ
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(BACKUP_DIR, "last-backup.json"),
        JSON.stringify(
          { ok: false, at: new Date().toISOString(), error: e.message },
          null,
          2,
        ),
      );
    } catch (_) {}

    process.exit(1);
  });
}

module.exports = { main, retentionPlan, listBackups, BACKUP_DIR };
