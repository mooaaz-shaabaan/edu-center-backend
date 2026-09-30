// // src/config/db.js
// const { PrismaClient } = require("@prisma/client");

// const prisma = new PrismaClient({
//   datasourceUrl: process.env.DATABASE_URL,
//   log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
// });

// module.exports = prisma;

const { PrismaClient } = require("@prisma/client");

// Prisma ستقوم تلقائياً بقراءة DATABASE_URL من ملف .env
const prisma = new PrismaClient();

module.exports = prisma;
