// src/core/backup.scheduler.js
//
// بيخلّي النسخ الاحتياطي يحصل لوحده من غير ما حد يفتكر.
//
// بيشتغل بطريقتين مع بعض:
//
//   ١) موعد يومي ثابت (افتراضي ٢ الفجر)
//   ٢) **تعويض** أول ما السيرفر يقوم: لو آخر نسخة ناجحة بقالها
//      أكتر من ٢٠ ساعة، بياخد واحدة فوراً.
//
// ⚠ النقطة (٢) هي اللي بتخلّي الموضوع يشتغل أصلاً. السنتر
//   بيقفل الساعة ١٠ بالليل والجهاز بيتطفي — فموعد ٢ الفجر
//   لوحده ممكن مايجيش ولا مرة طول السنة، وانت فاكر نفسك
//   متغطّي.
//
// الإعدادات (كلها اختيارية):
//   BACKUP_ENABLED   false عشان توقّفه خالص
//   BACKUP_CRON      الموعد اليومي        (افتراضي "0 2 * * *")
//   BACKUP_TZ        المنطقة الزمنية      (افتراضي Africa/Cairo)
//   BACKUP_MAX_AGE_H بعد كام ساعة يعوّض   (افتراضي 20)

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const { main: runBackup, BACKUP_DIR } = require("../../scripts/backup");

const CRON = process.env.BACKUP_CRON || "0 2 * * *";
const TZ = process.env.BACKUP_TZ || "Africa/Cairo";
const MAX_AGE_H = Number(process.env.BACKUP_MAX_AGE_H || 20);
const ENABLED = String(process.env.BACKUP_ENABLED ?? "true") !== "false";

// أول نسخة بعد ما السيرفر يقوم بدقيقة — عشان البرنامج يبقى
// جاهز للموظف الأول اللي بيفتح، مش مستني نسخة
const STARTUP_DELAY_MS = 60_000;

let running = false;

// ── سجل بسيط ──────────────────────────────────────────────
function note(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log("[backup]", line);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.appendFileSync(path.join(BACKUP_DIR, "backup.log"), stamped + "\n");
  } catch (_) {
    // السجل مش أهم من الشغل نفسه
  }
}

function lastSuccessAt() {
  try {
    const raw = fs.readFileSync(
      path.join(BACKUP_DIR, "last-backup.json"),
      "utf8",
    );
    const s = JSON.parse(raw);
    return s.ok ? new Date(s.at) : null;
  } catch (_) {
    return null; // مفيش ولا نسخة لسه
  }
}

/** بيرجّع عدد الساعات من آخر نسخة ناجحة، أو Infinity لو مفيش */
function hoursSinceLastSuccess() {
  const at = lastSuccessAt();
  if (!at || isNaN(at)) return Infinity;
  return (Date.now() - at.getTime()) / 3_600_000;
}

async function backupNow(reason) {
  // ⚠ القفل ده مش رفاهية: التعويض وقت القيام ممكن يتقاطع مع
  //   الموعد اليومي، واتنين pg_dump على نفس الملف بيبوّظوه
  if (running) {
    note(`تخطّي (${reason}) — فيه نسخة شغالة دلوقتي`);
    return;
  }

  running = true;
  try {
    const s = await runBackup();
    note(
      `نجحت (${reason}) — ${s.file}` +
        (s.mirrored ? " + نسخة تانية" : " — من غير نسخة تانية"),
    );
  } catch (e) {
    note(`فشلت (${reason}) — ${e.message}`);
  } finally {
    running = false;
  }
}

function startBackupScheduler() {
  if (!ENABLED) {
    console.log("[backup] متوقّف (BACKUP_ENABLED=false)");
    return;
  }

  if (!cron.validate(CRON)) {
    console.error(`[backup] ✖ BACKUP_CRON مش صحيح: "${CRON}" — الجدولة اتلغت`);
    return;
  }

  cron.schedule(CRON, () => backupNow("الموعد اليومي"), { timezone: TZ });
  console.log(`[backup] الموعد اليومي: ${CRON} (${TZ})`);

  // التعويض
  setTimeout(() => {
    const age = hoursSinceLastSuccess();

    if (age === Infinity) {
      note("مفيش ولا نسخة قبل كده — بناخد واحدة دلوقتي");
      return backupNow("أول نسخة");
    }

    if (age >= MAX_AGE_H) {
      note(`آخر نسخة بقالها ${Math.round(age)} ساعة — بنعوّض`);
      return backupNow("تعويض");
    }

    console.log(`[backup] آخر نسخة من ${Math.round(age)} ساعة — تمام`);
  }, STARTUP_DELAY_MS).unref();
  // unref: مايمنعش البرنامج من القفل لو اتقفل في الدقيقة دي
}

module.exports = { startBackupScheduler, backupNow, hoursSinceLastSuccess };
