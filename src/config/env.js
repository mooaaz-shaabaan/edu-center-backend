// src/config/env.js
// بيتحقق من وجود كل الـ env variables المهمة عند بدء السيرفر

const required = [
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_EXPIRES_IN",
];

function validateEnv() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("✅ Environment variables validated");
}

module.exports = { validateEnv };
