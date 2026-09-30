// src/index.js — Entry Point
require("dotenv").config(); // ← لازم يفضل أول سطر (الـ TZ بيتقري من هنا)

const { validateEnv } = require("./config/env");
validateEnv();

const app = require("./app");
const prisma = require("./config/db");

const PORT = process.env.PORT || 3000;
let server;

const { startBackupScheduler } = require("./core/backup.scheduler");

async function main() {
  try {
    await prisma.$connect();
    console.log("✅ Database connected");

    server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
      console.log(
        `🕐 Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} — ${new Date().toString()}`,
      );

      startBackupScheduler();
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

main();

// ── Graceful Shutdown ─────────────────────────────────────
// ⚠ اتصلح هنا ٣ حاجات:
//   1) الـ setTimeout الاحتياطي كان بعد process.exit — يعني عمره ما اتسجّل
//   2) uncaughtException كان بيخرج بكود 0، فـ PM2/systemd بيعتبره إغلاق
//      سليم وماكانش بيعيد التشغيل — السيرفر كان بيموت في صمت
//   3) Ctrl+C مرتين كان بينادي shutdown مرتين
let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  // لو الإغلاق علّق، اقفل بالعافية — لازم يتسجّل الأول
  const forceTimer = setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  // وقّف استقبال requests جديدة، واستنى اللي شغال يخلص
  if (server) {
    await new Promise((resolve) => {
      server.close(() => {
        console.log("🔌 HTTP server closed");
        resolve();
      });
    });
  }

  try {
    await prisma.$disconnect();
    console.log("👋 Database disconnected");
    clearTimeout(forceTimer);
    process.exit(exitCode);
  } catch (err) {
    console.error("Error during shutdown:", err);
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM")); // Docker/PM2/Kubernetes

// ── أخطاء غير متوقعة ──────────────────────────────────────
// الخروج بكود 1 مهم — ده اللي بيخلي مدير العمليات يعيد التشغيل
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  shutdown("uncaughtException", 1);
});
