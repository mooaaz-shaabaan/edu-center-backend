// src/middlewares/plan_gate.js
//
// سقف اشتراك السنتر على مستوى الـ API كله.
//
// ⚠ ليه هنا مش في كل راوت؟
//
//   الفحص كان جوه `requireBranchAccess(feature)` بس — و٤ موديولز
//   بس هي اللي بتستعمله (attendance · payments · expenses ·
//   registrations). الباقي (students · courses · semesters ·
//   reports · shifts · users · branches) كان على `requireRole`
//   لوحده، يعني **مفيش أي فحص اشتراك**.
//
//   النتيجة: السوبر أدمن يوقف «التقارير»، العنصر يختفي من
//   القايمة، والسنتر يفضل يجيب تقاريره عادي من أي طلب مباشر.
//
//   مكان واحد على `/api` معناه إن أي راوت جديد بيتحط في المستقبل
//   بيتحمي لوحده. القايمة تحت صريحة عن قصد: راوت مش فيها = مفتوح.

const DENY = (res, feature) =>
  res.status(403).json({
    success: false,
    code: "FEATURE_NOT_IN_PLAN",
    message: "الخدمة دي مش في اشتراك السنتر.",
    requiredFeature: feature,
  });

/**
 * المسار (بعد `/api`) → الفيتشر اللي لازم تكون في الاشتراك.
 *
 * ⚠ الترتيب مهم: `/payments/expenses` لازم تيجي قبل `/payments`.
 */
const RULES = [
  // المصروفات موديول لوحدها جوه راوتس المدفوعات
  [/^\/payments\/expenses(\/|$)/, "expenses"],
  [/^\/payments(\/|$)/, "payments"],

  [/^\/students(\/|$)/, "students"],
  [/^\/registrations(\/|$)/, "registrations"],
  [/^\/attendance(\/|$)/, "attendance"],
  [/^\/courses(\/|$)/, "courses"],

  // التسجيل في الفصول جزء من نفس الشاشة
  [/^\/semesters(\/|$)/, "semesters"],
  [/^\/enrollments(\/|$)/, "semesters"],

  [/^\/exams(\/|$)/, "exams"],
  [/^\/reports(\/|$)/, "reports"],

  // الورديات والأدراج حاجة واحدة — الدرج مالوش معنى من غير وردية
  [/^\/shifts(\/|$)/, "shifts"],
  [/^\/drawers(\/|$)/, "drawers_is_shifts"],

  [/^\/users(\/|$)/, "users"],
  [/^\/branches(\/|$)/, "branches"],
];

/**
 * استثناءات — مسارات بتعدّي مهما كان الاشتراك.
 *
 * ⚠ تغيير باسوردك مش «إدارة مستخدمين». من غير الاستثناء ده، سنتر
 *   من غير خدمة «المستخدمين» مالوش أي طريقة يغيّر بيها باسورد
 *   الدخول اللي اتبعتله في الواتس.
 */
const OPEN = [/^\/users\/\d+\/password$/];

/** `/rooms` تبع موديول الفروع بس القاعات بتتستعمل في جداول
 *  المواد — قفلها مع «الفروع» كان هيكسر المواعيد. */
const featureFor = (path) => {
  if (OPEN.some((re) => re.test(path))) return null;
  const hit = RULES.find(([re]) => re.test(path));
  if (!hit) return null;
  return hit[1] === "drawers_is_shifts" ? "shifts" : hit[1];
};

/**
 * المسار ده ممنوع على الخطة دي؟ بيرجّع اسم الفيتشر، أو null.
 *
 * `features === null` → سوبر أدمن، مالوش سقف.
 */
const planDenial = (apiPath, features) => {
  if (features === null || features === undefined) return null;
  const feature = featureFor(apiPath);
  return feature && !features.includes(feature) ? feature : null;
};

module.exports = { planDenial, featureFor };
