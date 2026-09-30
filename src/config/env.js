// src/config/env.js
// بيتحقق من وجود وجودة الـ env variables المهمة عند بدء السيرفر.
// لو فيه حاجة ناقصة أو ضعيفة → يوقف السيرفر فورًا (fail-fast).

const required = ["DATABASE_URL", "JWT_SECRET", "JWT_EXPIRES_IN"];

// قيم افتراضية معروفة ممنوع تتستخدم
const FORBIDDEN_SECRETS = [
  "your_super_secret_jwt_key_change_in_production",
  "secret",
  "secret123",
  "changeme",
  "jwt_secret",
  "test",
];

function validateEnv() {
  const errors = [];
  const isProd = process.env.NODE_ENV === "production";

  // ── 1) الوجود (زي ما كان) ───────────────────────────────
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    errors.push(`Missing required variables: ${missing.join(", ")}`);
  }

  // ── 2) جودة الـ JWT_SECRET ──────────────────────────────
  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret) {
    if (jwtSecret.length < 32) {
      errors.push(
        `JWT_SECRET too short (${jwtSecret.length} chars). Use 64+ chars.`,
      );
    }
    if (FORBIDDEN_SECRETS.includes(jwtSecret.toLowerCase().trim())) {
      errors.push(
        "JWT_SECRET is a default/known value. Generate a new one:\n" +
          "     node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"",
      );
    }
  }

  // ── 3) صحة الـ DATABASE_URL ─────────────────────────────
  if (
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.startsWith("postgresql://")
  ) {
    errors.push("DATABASE_URL must be a valid PostgreSQL connection string.");
  }

  // ── 4) فحوصات production ────────────────────────────────
  if (isProd) {
    const origins = process.env.ALLOWED_ORIGINS;
    if (!origins || origins.trim() === "") {
      errors.push("ALLOWED_ORIGINS is required in production.");
    } else if (origins.includes("*")) {
      errors.push("ALLOWED_ORIGINS must not contain '*' in production.");
    }
    if (jwtSecret && jwtSecret.length < 64) {
      errors.push("JWT_SECRET should be 64+ chars in production.");
    }
  }

  // ── النتيجة ─────────────────────────────────────────────
  if (errors.length > 0) {
    console.error("\n❌ Environment validation failed:\n");
    errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}\n`));
    console.error("Fix .env and restart.\n");
    process.exit(1);
  }

  console.log(
    `✅ Environment validated (${isProd ? "production" : "development"} mode)`,
  );
}

module.exports = { validateEnv };
