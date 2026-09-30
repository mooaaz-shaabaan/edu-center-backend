// prisma/seed.js
// بينشئ أول سنتر + أول حساب super_admin (انت، مالك النظام)
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // ── 1) أنشئ أول سنتر (تجريبي) ─────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: {
      name: "السنتر التجريبي",
      slug: "demo",
      email_domain: "demo.com",
    },
  });
  console.log(`✅ Tenant created: ${tenant.name} (id: ${tenant.id})`);

  // ── 2) أنشئ أول فرع للسنتر ده ─────────────────────────
  const branch = await prisma.branch.upsert({
    where: { id: 1 },
    update: {},
    create: {
      tenant_id: tenant.id,
      name: "الفرع الرئيسي",
      address: "القاهرة",
      phone: "01000000000",
    },
  });
  console.log(`✅ Branch created: ${branch.name} (id: ${branch.id})`);

  // ── 3) أنشئ حساب super_admin (انت) ─────────────────────
  // الـ super_admin مش تابع لسنتر (tenant_id = null) — بيدير الكل
  const SUPER_ADMIN_EMAIL = "owner@system.com";
  const SUPER_ADMIN_PASSWORD = "owner123"; // ← غيّره فورًا بعد أول login

  const hashedPassword = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 12);

  const superAdmin = await prisma.user.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    update: {},
    create: {
      name: "مالك النظام",
      email: SUPER_ADMIN_EMAIL,
      password: hashedPassword,
      role: "super_admin",
      tenant_id: null, // ← مش تابع لسنتر
      branch_id: null,
    },
  });
  console.log(`✅ Super Admin created: ${superAdmin.email}`);

  // ── 4) أنشئ admin للسنتر التجريبي ──────────────────────
  const TENANT_ADMIN_EMAIL = "admin@admin.com";
  const TENANT_ADMIN_PASSWORD = "admin123"; // ← غيّره فورًا

  const tenantAdminPass = await bcrypt.hash(TENANT_ADMIN_PASSWORD, 12);

  const tenantAdmin = await prisma.user.upsert({
    where: { email: TENANT_ADMIN_EMAIL },
    update: {},
    create: {
      name: "أدمن السنتر التجريبي",
      email: TENANT_ADMIN_EMAIL,
      password: tenantAdminPass,
      role: "admin",
      tenant_id: tenant.id, // ← تابع للسنتر التجريبي
      branch_id: branch.id,
    },
  });
  console.log(`✅ Tenant Admin created: ${tenantAdmin.email}`);

  // ── 4) أنشئ admin للسنتر التجريبي ──────────────────────
  const EMPLOYEE_EMAIL = "employee@employee.com";
  const EMPLOYEE_PASSWORD = "employee123"; // ← غيّره فورًا

  const EmployeePass = await bcrypt.hash(EMPLOYEE_PASSWORD, 12);

  const employee = await prisma.user.upsert({
    where: { email: EMPLOYEE_EMAIL },
    update: {},
    create: {
      name: "موظف الأستقبال",
      email: EMPLOYEE_EMAIL,
      password: EmployeePass,
      role: "receptionist",
      tenant_id: tenant.id, // ← تابع للسنتر التجريبي
      branch_id: branch.id,
    },
  });
  console.log(`✅ Employee created: ${employee.email}`);

  console.log("\n🎉 Seeding complete!");
  console.log("─────────────────────────────────────");
  console.log("Super Admin (مالك النظام):");
  console.log(`  email: ${SUPER_ADMIN_EMAIL}`);
  console.log(`  password: ${SUPER_ADMIN_PASSWORD}`);
  console.log("Tenant Admin (أدمن السنتر التجريبي):");
  console.log(`  email: ${TENANT_ADMIN_EMAIL}`);
  console.log(`  password: ${TENANT_ADMIN_PASSWORD}`);
  console.log("─────────────────────────────────────");
  console.log("⚠️  غيّر الباسوردات دي فورًا بعد أول تسجيل دخول!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

 