// scripts/restore.js
//
// استرجاع نسخة احتياطية.
//
//   node scripts/restore.js                      عرض النسخ المتاحة
//   node scripts/restore.js --test               تجربة آمنة (قاعدة مؤقتة)
//   node scripts/restore.js --into edu_check     استرجاع في قاعدة تانية
//   node scripts/restore.js --overwrite          فوق القاعدة الحقيقية ⚠
//
// اختيار نسخة معيّنة (الافتراضي أحدث واحدة):
//   --file edu-center-20260930-0200.dump
//
// ── ابدأ بـ --test ────────────────────────────────────────
// بيرجّع النسخة في قاعدة مؤقتة، يعدّ الصفوف في كل جدول،
// وبعدين يمسح القاعدة المؤقتة. القاعدة الحقيقية مابتتلمسش.
// نسخة محدش جرّب يرجّعها مرة مش نسخة — دي الطريقة اللي
// تتأكد بيها من غير مخاطرة.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { spawn } = require("child_process");

const { listBackups, BACKUP_DIR } = require("./backup");

// ── أدوات ─────────────────────────────────────────────────
const log = (...a) => console.log("[restore]", ...a);
const warn = (...a) => console.warn("[restore] ⚠", ...a);
const fail = (...a) => console.error("[restore] ✖", ...a);

const isWin = os.platform() === "win32";
const exe = (n) => (isWin ? `${n}.exe` : n);

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
      e.stderr = err;
      e.code = code;
      reject(e);
    });
  });
}

function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  if (isWin) {
    for (const root of ["C:\\Program Files\\PostgreSQL", "C:\\PostgreSQL"]) {
      if (!fs.existsSync(root)) continue;
      const versions = fs
        .readdirSync(root)
        .filter((v) => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a));
      for (const v of versions) {
        const bin = path.join(root, v, "bin");
        if (fs.existsSync(path.join(bin, exe("pg_restore")))) return bin;
      }
    }
  }
  return null;
}

const tool = (bin, name) => (bin ? path.join(bin, exe(name)) : exe(name));

function parseDbUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL مش موجود في .env");
  const u = new URL(raw);
  return {
    host: u.hostname || "localhost",
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ""),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

// ── الأوامر ───────────────────────────────────────────────
const bin = findPgBin();
const db = parseDbUrl();
const env = db.password ? { PGPASSWORD: db.password } : {};

const conn = (dbName) => [
  "-h",
  db.host,
  "-p",
  String(db.port),
  "-U",
  db.user,
  "-d",
  dbName,
];

/** psql بصيغة نظيفة للقراية بالكود */
const sql = (dbName, query) =>
  run(
    tool(bin, "psql"),
    [
      ...conn(dbName),
      "-t",
      "-A",
      "-F",
      "|",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ],
    env,
  );

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

// ── عدّ الصفوف في كل جدول ─────────────────────────────────
// ⚠ مش بنكتب أسماء جداول بإيدنا — الأسماء بتتغير مع أي تعديل
//   في السكيما، والفحص اللي بيعتمد على أسماء قديمة بيقول
//   "تمام" وهو مابيبصش على نص القاعدة.
const COUNT_ALL = `
SELECT table_name, (xpath('/row/c/text()', x))[1]::text::bigint AS n
FROM (
  SELECT table_name,
         query_to_xml(format('select count(*) as c from %I.%I',
                             table_schema, table_name), false, true, '') AS x
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
) t
ORDER BY n DESC, table_name`;

async function tableCounts(dbName) {
  const out = await sql(dbName, COUNT_ALL);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, n] = l.split("|");
      return { name, rows: Number(n) };
    });
}

function printCounts(rows) {
  const withData = rows.filter((r) => r.rows > 0);
  const total = rows.reduce((s, r) => s + r.rows, 0);

  log(
    `الجداول: ${rows.length} — فيها بيانات: ${withData.length} — إجمالي الصفوف: ${total}`,
  );
  for (const r of withData.slice(0, 15)) {
    console.log(`        ${String(r.rows).padStart(7)}  ${r.name}`);
  }
  if (withData.length > 15) {
    console.log(`        … و${withData.length - 15} جدول كمان`);
  }
  return { tables: rows.length, withData: withData.length, total };
}

// ── الاسترجاع نفسه ────────────────────────────────────────
async function restoreInto(dbName, file) {
  const args = [
    ...conn(dbName),
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--single-transaction", // يا يرجع كامل يا مايرجعش خالص
    file,
  ];

  try {
    await run(tool(bin, "pg_restore"), args, env);
  } catch (e) {
    // pg_restore بيطلّع تحذيرات على stderr وبيرجّع كود != 0
    // حتى لو الاسترجاع نجح. بنفرّق بين تحذير وخطأ حقيقي.
    const text = e.stderr || e.message || "";
    const realErrors = text
      .split("\n")
      .filter((l) => /^pg_restore: error:/i.test(l.trim()));
    if (realErrors.length) throw new Error(realErrors.slice(0, 5).join("\n"));
    warn("pg_restore طلّع تحذيرات (متجاهَلة):");
    console.log(text.trim().split("\n").slice(0, 5).join("\n"));
  }
}

async function createDb(name) {
  await sql("postgres", `CREATE DATABASE "${name}"`);
}

async function dropDb(name) {
  await sql(
    "postgres",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  );
  await sql("postgres", `DROP DATABASE IF EXISTS "${name}"`);
}

async function activeConnections(dbName) {
  const out = await sql(
    "postgres",
    `SELECT count(*) FROM pg_stat_activity
     WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
  return Number(out.trim()) || 0;
}

// ── الأوضاع ───────────────────────────────────────────────
async function modeList(files) {
  if (files.length === 0) {
    warn(`مفيش ولا نسخة في ${BACKUP_DIR}`);
    log("شغّل: npm run backup");
    return;
  }

  log(`${files.length} نسخة في ${BACKUP_DIR}:\n`);
  for (const f of files.slice(0, 20)) {
    const size = fs.statSync(path.join(BACKUP_DIR, f.name)).size;
    console.log(
      `   ${f.name}   ${(size / 1024 / 1024).toFixed(1)} MB   ` +
        `${f.date.toLocaleString("ar-EG")}`,
    );
  }
  if (files.length > 20) console.log(`   … و${files.length - 20} كمان`);

  console.log(`
جرّب النسخة من غير أي مخاطرة:
   node scripts/restore.js --test

استرجاع في قاعدة تانية (تبص عليها بنفسك):
   node scripts/restore.js --into edu_check

استرجاع فوق القاعدة الحقيقية (اقفل السيرفر الأول):
   node scripts/restore.js --overwrite
`);
}

async function modeTest(file, fileName) {
  const scratch = `${db.database}_restore_test_${Date.now()}`;
  log(`تجربة: ${fileName}`);
  log(`قاعدة مؤقتة: ${scratch}`);

  await createDb(scratch);
  try {
    await restoreInto(scratch, file);
    const counts = await tableCounts(scratch);
    const summary = printCounts(counts);

    if (summary.total === 0) {
      throw new Error("النسخة رجعت فاضية — مفيش ولا صف في أي جدول.");
    }

    log("✓ النسخة سليمة وبترجع تمام.");
    return summary;
  } finally {
    // تتمسح حتى لو الاسترجاع فشل — مانسيبش قواعد زبالة ورانا
    try {
      await dropDb(scratch);
      log(`اتمسحت القاعدة المؤقتة ${scratch}`);
    } catch (e) {
      warn(`مقدرناش نمسح ${scratch}: ${e.message} — امسحها بإيدك`);
    }
  }
}

async function modeInto(target, file, fileName) {
  log(`استرجاع ${fileName} في القاعدة: ${target}`);

  try {
    await createDb(target);
    log(`اتعملت القاعدة ${target}`);
  } catch (e) {
    if (/already exists/i.test(e.message)) {
      const ok = await ask(
        `القاعدة "${target}" موجودة. تمسح اللي فيها؟ (اكتب نعم): `,
      );
      if (ok !== "نعم") return log("اتلغى.");
    } else throw e;
  }

  await restoreInto(target, file);
  printCounts(await tableCounts(target));
  log(`✓ خلص. القاعدة "${target}" فيها النسخة — بص عليها وامسحها لما تخلص.`);
}

async function modeOverwrite(file, fileName, kick) {
  const target = db.database;

  console.log(`
╔════════════════════════════════════════════════════════╗
   ⚠  استرجاع فوق القاعدة الشغّالة

   القاعدة:  ${target}
   النسخة:   ${fileName}

   كل البيانات اللي اتسجّلت بعد النسخة دي هتضيع
   ولا حاجة منها هترجع.
╚════════════════════════════════════════════════════════╝
`);

  // ١) محدش شغال عليها
  const active = await activeConnections(target);
  if (active > 0) {
    if (!kick) {
      fail(
        `فيه ${active} اتصال شغال على القاعدة.\n` +
          "        اقفل السيرفر (وبرنامج الفلاتر) وجرّب تاني.\n" +
          "        لو مضطر تكمّل: زوّد --kick",
      );
      process.exit(1);
    }
    warn(`بنقفل ${active} اتصال شغال…`);
    await sql(
      "postgres",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${target}' AND pid <> pg_backend_pid()`,
    );
  }

  // ٢) تأكيد بكتابة اسم القاعدة — مش "نعم"
  const typed = await ask(`اكتب اسم القاعدة بالظبط عشان تأكّد (${target}): `);
  if (typed !== target) {
    return log("الاسم مش مطابق — اتلغى.");
  }

  // ٣) نسخة أمان من الحالة الحالية قبل ما نمسحها
  //    ⚠ لو النسخة اللي بترجّعها طلعت غلط، دي اللي بترجّعك
  //      لمكانك. اسمها مختلف عشان التنضيف التلقائي مايمسحهاش.
  const safety = path.join(
    BACKUP_DIR,
    `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`,
  );
  log("بناخد نسخة أمان من الحالة الحالية الأول…");
  await run(
    tool(bin, "pg_dump"),
    [...conn(target), "-Fc", "--no-owner", "--no-privileges", "-f", safety],
    env,
  );
  log(`✓ نسخة الأمان: ${path.basename(safety)}`);

  // ٤) الاسترجاع
  await restoreInto(target, file);
  printCounts(await tableCounts(target));

  log("✓ خلص. شغّل السيرفر وافتح البرنامج وتأكد من البيانات.");
  log(
    `لو حاجة غلط: node scripts/restore.js --overwrite --file ${path.basename(safety)}`,
  );
}

// ── المدخلات ──────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: "list", file: null, into: null, kick: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--test") a.mode = "test";
    else if (t === "--overwrite") a.mode = "overwrite";
    else if (t === "--kick") a.kick = true;
    else if (t === "--into") {
      a.mode = "into";
      a.into = argv[++i];
    } else if (t === "--file") a.file = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = listBackups(BACKUP_DIR).sort((x, y) => y.date - x.date);

  if (args.mode === "list") return modeList(files);

  if (files.length === 0) {
    throw new Error(`مفيش ولا نسخة في ${BACKUP_DIR}`);
  }

  const chosen = args.file ? args.file : files[0].name;
  const full = path.join(BACKUP_DIR, chosen);

  if (!fs.existsSync(full)) {
    throw new Error(`الملف مش موجود: ${full}`);
  }

  if (args.mode === "test") return modeTest(full, chosen);
  if (args.mode === "into") {
    if (!args.into) throw new Error("--into محتاج اسم قاعدة");
    return modeInto(args.into, full, chosen);
  }
  if (args.mode === "overwrite") {
    return modeOverwrite(full, chosen, args.kick);
  }
}

if (require.main === module) {
  main().catch((e) => {
    fail(e.message);
    process.exit(1);
  });
}
