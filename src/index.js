// src/index.js — Entry Point
require("dotenv").config();

const { validateEnv } = require("./config/env");
validateEnv();

const app = require("./app");
const prisma = require("./config/db");

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    // Test DB connection
    await prisma.$connect();
    console.log("✅ Database connected");

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

main();

// Graceful shutdown
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  console.log("👋 Server shut down gracefully");
  process.exit(0);
});
