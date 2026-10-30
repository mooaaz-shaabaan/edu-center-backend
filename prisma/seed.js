// prisma/seed.js

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

function assertSafeInProduction() {
  if (process.env.NODE_ENV !== "production") return;

  const missing = [
    "SEED_ADMIN_EMAIL",
    "SEED_ADMIN_PASSWORD",
    "SEED_TENANT_ADMIN_EMAIL",
    "SEED_TENANT_ADMIN_PASSWORD",
  ].filter((key) => !process.env[key]);

  if (missing.length) {
    console.error(
      `\n❌ ناقص Environment Variables: ${missing.join(", ")}\n`
    );
    process.exit(1);
  }

  if (String(process.env.SEED_ADMIN_PASSWORD).length < 10) {
    console.error("\n❌ باسورد الـ Super Admin لازم يكون 10 حروف على الأقل.\n");
    process.exit(1);
  }

  if (String(process.env.SEED_TENANT_ADMIN_PASSWORD).length < 10) {
    console.error("\n❌ باسورد Admin السنتر لازم يكون 10 حروف على الأقل.\n");
    process.exit(1);
  }
}

async function main() {
  assertSafeInProduction();

  console.log("🌱 Seeding database...");

  // ─────────────────────────────────────────
  // 1) إنشاء سنتر واحد فقط
  // ─────────────────────────────────────────

  const tenant = await prisma.tenant.upsert({
    where: {
      slug: "demo",
    },
    update: {},
    create: {
      name: "السنتر التجريبي",
      slug: "demo",
      email_domain: "demo.com",
    },
  });

  console.log(`✅ Tenant created: ${tenant.name}`);


  // ─────────────────────────────────────────
  // 2) إنشاء فرع واحد للسنتر
  // ─────────────────────────────────────────

  const branch = await prisma.branch.upsert({
    where: {
      id: 1,
    },
    update: {},
    create: {
      tenant_id: tenant.id,
      name: "الفرع الرئيسي",
      address: "القاهرة",
      phone: "01000000000",
    },
  });

  console.log(`✅ Branch created: ${branch.name}`);


  // ─────────────────────────────────────────
  // 3) إنشاء Super Admin
  // owner@system.com
  // ─────────────────────────────────────────

  const SUPER_ADMIN_EMAIL =
    process.env.SEED_ADMIN_EMAIL || "owner@system.com";

  const SUPER_ADMIN_PASSWORD =
    process.env.SEED_ADMIN_PASSWORD || "22992921o";

  const superAdminPassword = await bcrypt.hash(
    SUPER_ADMIN_PASSWORD,
    12
  );

  const superAdmin = await prisma.user.upsert({
    where: {
      email: SUPER_ADMIN_EMAIL,
    },
    update: {
      password: superAdminPassword,
      role: "super_admin",
      tenant_id: null,
      branch_id: null,
    },
    create: {
      name: "مالك النظام",
      email: SUPER_ADMIN_EMAIL,
      password: superAdminPassword,
      role: "super_admin",
      tenant_id: null,
      branch_id: null,
    },
  });

  console.log(`✅ Super Admin created: ${superAdmin.email}`);


  // ─────────────────────────────────────────
  // 4) إنشاء Admin واحد فقط للسنتر
  // ─────────────────────────────────────────

  const TENANT_ADMIN_EMAIL =
    process.env.SEED_TENANT_ADMIN_EMAIL || "admin@admin.com";

  const TENANT_ADMIN_PASSWORD =
    process.env.SEED_TENANT_ADMIN_PASSWORD || "admin12345";

  const tenantAdminPassword = await bcrypt.hash(
    TENANT_ADMIN_PASSWORD,
    12
  );

  const tenantAdmin = await prisma.user.upsert({
    where: {
      email: TENANT_ADMIN_EMAIL,
    },
    update: {
      password: tenantAdminPassword,
      role: "admin",
      tenant_id: tenant.id,
      branch_id: branch.id,
    },
    create: {
      name: "أدمن السنتر",
      email: TENANT_ADMIN_EMAIL,
      password: tenantAdminPassword,
      role: "admin",
      tenant_id: tenant.id,
      branch_id: branch.id,
    },
  });

  console.log(`✅ Tenant Admin created: ${tenantAdmin.email}`);

  console.log("\n🎉 Seeding complete!");
  console.log("✅ 1 Center");
  console.log("✅ 1 Super Admin");
  console.log("✅ 1 Center Admin");
}

main()
  .catch((error) => {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
