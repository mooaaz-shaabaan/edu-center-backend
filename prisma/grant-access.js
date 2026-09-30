// prisma/grant-access.js
// سكريبت لمرة واحدة: يمنح المستخدمين الحاليين صلاحيات على فروعهم
// (البيانات القديمة اتعملت seed قبل ما يبقى فيه user_branch_access)

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const ALL_FEATURES =
  "attendance,payments,reports,schedules,expenses,courses,students";
const BASIC_FEATURES = "attendance,payments";

const featuresFor = (role) =>
  role === "admin" ? ALL_FEATURES : BASIC_FEATURES;

async function main() {
  console.log("🔑 منح صلاحيات الفروع للمستخدمين الحاليين...\n");

  const users = await prisma.user.findMany({
    where: { role: { in: ["admin", "receptionist"] } },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      branch_id: true,
      tenant_id: true,
    },
  });

  if (users.length === 0) {
    console.log("⚠️  مفيش مستخدمين بأدوار admin أو receptionist.");
    return;
  }

  let granted = 0;
  let skipped = 0;

  for (const u of users) {
    if (!u.branch_id) {
      console.log(`⏭  ${u.name} (${u.email}) — مفيش branch_id`);
      skipped++;
      continue;
    }

    // اتأكد إن الفرع تابع لنفس السنتر
    const branch = await prisma.branch.findFirst({
      where: { id: u.branch_id, tenant_id: u.tenant_id },
      select: { id: true, name: true },
    });

    if (!branch) {
      console.log(
        `⚠️  ${u.name} — الفرع ${u.branch_id} مش تابع للسنتر ${u.tenant_id}`
      );
      skipped++;
      continue;
    }

    const features = featuresFor(u.role);

    await prisma.userBranchAccess.upsert({
      where: {
        uq_user_branch: { user_id: u.id, branch_id: u.branch_id },
      },
      create: {
        tenant_id: u.tenant_id,
        user_id: u.id,
        branch_id: u.branch_id,
        features,
      },
      update: { features },
    });

    console.log(`✅ ${u.name} (${u.role}) → ${branch.name}`);
    console.log(`   ${features.split(",").length} صلاحية\n`);
    granted++;
  }

  console.log(`─────────────────────────────`);
  console.log(`✅ اتمنح: ${granted}`);
  console.log(`⏭  اتخطى: ${skipped}`);

  // ملاحظة للـ owner/super_admin
  const fullAccess = await prisma.user.count({
    where: { role: { in: ["owner", "super_admin"] } },
  });
  if (fullAccess > 0) {
    console.log(
      `\nℹ️  ${fullAccess} مستخدم بدور owner/super_admin — عندهم وصول ضمني لكل الفروع، مش محتاجين صفوف.`
    );
  }
}

main()
  .catch((e) => {
    console.error("❌ فشل:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });