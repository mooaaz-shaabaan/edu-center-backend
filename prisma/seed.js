// prisma/seed.js
// بيعمل أول Admin user وأول Branch تلقائياً

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // عمل أول Branch
  const branch = await prisma.branch.upsert({
    where: { id: 1 },
    update: {},
    create: {
      name: "الفرع الرئيسي",
      address: "القاهرة",
      phone: "01000000000",
    },
  });
  console.log(`✅ Branch created: ${branch.name}`);

  // عمل Admin user
  const hashedPassword = await bcrypt.hash("admin123", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@educenter.com" },
    update: {},
    create: {
      name: "Admin",
      email: "admin@educenter.com",
      password: hashedPassword,
      role: "admin",
      branch_id: branch.id,
    },
  });
  console.log(`✅ Admin created: ${admin.email}`);
  console.log(`🔑 Password: admin123`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
