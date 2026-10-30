// prisma/seed.js
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

function assertSafeInProduction() {
  if (process.env.NODE_ENV !== "production") return;

  const missing = ["SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD"].filter(
    (key) => !process.env[key]
  );

  if (missing.length) {
    console.error(
      `\n❌ مينفعش تعمل seed على production من غير: ${missing.join(" و ")}\n`
    );
    process.exit(1);
  }

  if (String(process.env.SEED_ADMIN_PASSWORD).length < 10) {
    console.error("\n❌ الباسورد قصير — ١٠ حروف على الأقل.\n");
    process.exit(1);
  }
}

async function main() {
  assertSafeInProduction();

  console.log("🌱 Seeding database...");

  const SUPER_ADMIN_EMAIL =
    process.env.SEED_ADMIN_EMAIL || "owner@system.com";

  const SUPER_ADMIN_PASSWORD =
    process.env.SEED_ADMIN_PASSWORD || "22992921o";

  const hashedPassword = await bcrypt.hash(
    SUPER_ADMIN_PASSWORD,
    12
  );

  const superAdmin = await prisma.user.upsert({
    where: {
      email: SUPER_ADMIN_EMAIL,
    },
    update: {
      password: hashedPassword,
      role: "super_admin",
      tenant_id: null,
      branch_id: null,
    },
    create: {
      name: "مالك النظام",
      email: SUPER_ADMIN_EMAIL,
      password: hashedPassword,
      role: "super_admin",
      tenant_id: null,
      branch_id: null,
    },
  });

  console.log(`✅ Super Admin created: ${superAdmin.email}`);
  console.log("\n🎉 Seeding complete!");
}

main()
  .catch((error) => {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
