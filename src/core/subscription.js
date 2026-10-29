// src/core/subscription.js
//
// حالة اشتراك السنتر، ومصدرها الوحيد صف الـ tenant.
//
// ⚠ الحساب مركزي عن قصد: الـ auth middleware بيقفل بيه، والكرون
//   بيطرد بيه، والـ API بيبلّغ بيه الفلاتر. لو كل واحد حسب لوحده،
//   سنتر كان هيتقفل في مكان ويفضل شغال في مكان تاني.

/** أيام السماح بعد تاريخ الانتهاء — تحذير بس، والشغل ماشي */
const GRACE_DAYS = 3;

/** الفيتشرز اللي ممكن تتباع للسنتر — لازم تطابق ALLOWED_FEATURES */
const TENANT_FEATURES = [
  "students",
  "registrations",
  "attendance",
  "courses",
  "semesters",
  "exams",
  "schedules",
  "payments",
  "expenses",
  "reports",
  "shifts",
  "users",
  "branches",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** CSV → ليستة نضيفة */
const parseFeatures = (csv) =>
  String(csv || "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

/** ليستة → CSV، بالترتيب المعروف ومن غير مكرر ولا أي اسم غريب */
const serializeFeatures = (list) => {
  const wanted = new Set(Array.isArray(list) ? list : []);
  return TENANT_FEATURES.filter((f) => wanted.has(f)).join(",");
};

/**
 * آخر لحظة في اليوم ده بالتوقيت المحلي.
 *
 * ⚠ الاشتراك اللي بينتهي «٢٠ أكتوبر» لازم يفضل شغال ٢٠ أكتوبر
 *   كله. من غير ده، تاريخ متخزّن ٠٠:٠٠ كان بيقفل السنتر من أول
 *   دقيقة في اليوم اللي العميل دافع عليه.
 */
const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);

/**
 * حالة الاشتراك:
 *
 *   open   → مفيش تاريخ انتهاء (السناتر القديمة) — شغال بلا نهاية
 *   active → لسه في مدته
 *   grace  → التاريخ عدّى بس جوه أيام السماح — شغال مع تحذير
 *   locked → عدّى السماح كمان — مقفول
 */
const subscriptionStatus = (tenant, now = new Date()) => {
  const endsAt = tenant?.subscription_ends_at || null;
  const isTrial = Boolean(tenant?.is_trial);

  if (!endsAt) {
    return {
      endsAt: null,
      isTrial,
      state: "open",
      daysLeft: null,
      graceDaysLeft: null,
      graceDays: GRACE_DAYS,
    };
  }

  const lastDay = endOfDay(endsAt);
  const graceEnd = endOfDay(addDays(endsAt, GRACE_DAYS));

  // كام يوم فاضل — صفر معناها بينتهي النهاردة، والسالب عدّى
  const daysLeft = Math.ceil((lastDay.getTime() - now.getTime()) / DAY_MS) - 1;

  let state = "active";
  if (now > graceEnd) state = "locked";
  else if (now > lastDay) state = "grace";

  return {
    endsAt,
    isTrial,
    state,
    daysLeft,
    graceDaysLeft:
      state === "grace"
        ? Math.ceil((graceEnd.getTime() - now.getTime()) / DAY_MS)
        : null,
    graceDays: GRACE_DAYS,
  };
};

/** الشكل اللي بيروح للفلاتر */
const publicStatus = (tenant, now = new Date()) => {
  const s = subscriptionStatus(tenant, now);
  return {
    subscription_ends_at: s.endsAt ? new Date(s.endsAt).toISOString() : null,
    subscription_state: s.state,
    subscription_days_left: s.daysLeft,
    subscription_grace_days: s.graceDays,
    is_trial: s.isTrial,
  };
};

module.exports = {
  GRACE_DAYS,
  TENANT_FEATURES,
  parseFeatures,
  serializeFeatures,
  subscriptionStatus,
  publicStatus,
  endOfDay,
  addDays,
};
