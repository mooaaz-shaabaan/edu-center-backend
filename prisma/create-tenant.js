// prisma/create-tenant.js
// ─────────────────────────────────────────────────────────────
// إنشاء سنتر جديد كامل: السنتر + أول فرع + حساب صاحب السنتر
//
// التشغيل:
//   node prisma/create-tenant.js
//
// عدّل الـ CONFIG تحت الأول، وبعدين شغّل.
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  // ── السنتر ────────────────────────────────────
  name: "سنتر النور",
  slug: "alnour", // إنجليزي وأرقام وشرطات بس — بيدخل في الروابط
  emailDomain: "alnour.com", // كل إيميلات السنتر لازم تكون عليه

  // ── أول فرع ───────────────────────────────────
  branchName: "الفرع الرئيسي",
  branchAddress: null, // اختياري
  branchPhone: null, // اختياري

  // ── حساب صاحب السنتر (owner) ──────────────────
  ownerName: "أحمد علي",
  ownerEmail: "owner", // الجزء اللي قبل @ بس — الدومين بيتركّب تلقائي
  ownerPassword: "Owner@12345", // 8 حروف على الأقل
};

// ─────────────────────────────────────────────────────────────

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
};

const main = async () => {
  // ── 1) تحقق من الشكل ────────────────────────────────────────
  const required = {
    name: "اسم السنتر",
    slug: "الـ slug",
    emailDomain: "الدومين",
    branchName: "اسم الفرع",
    ownerName: "اسم صاحب السنتر",
    ownerEmail: "إيميل صاحب السنتر",
    ownerPassword: "باسورد صاحب السنتر",
  };

  const missing = Object.entries(required)
    .filter(([key]) => !String(CONFIG[key] || "").trim())
    .map(([, label]) => label);

  if (missing.length) fail(`ناقص: ${missing.join("، ")}`);

  const slug = CONFIG.slug.toLowerCase().trim();
  const domain = CONFIG.emailDomain.toLowerCase().replace(/^@/, "").trim();
  const local = CONFIG.ownerEmail.toLowerCase().trim();

  if (!/^[a-z0-9-]+$/.test(slug)) {
    fail("الـ slug لازم يكون حروف إنجليزية صغيرة وأرقام وشرطات بس.");
  }

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    fail(`الدومين "${domain}" شكله مش صح. مثال: alnour.com`);
  }

  if (local.includes("@")) {
    fail("ownerEmail = الجزء اللي قبل @ بس. الدومين بيتركّب تلقائي.");
  }

  if (!/^[a-z0-9._%+-]+$/.test(local)) {
    fail("ownerEmail لازم حروف إنجليزية وأرقام بس.");
  }

  if (CONFIG.ownerPassword.length < 8) {
    fail("الباسورد لازم 8 حروف على الأقل.");
  }

  const email = `${local}@${domain}`;

  // ── 2) تحقق من التكرار ──────────────────────────────────────
  const [slugTaken, domainTaken, emailTaken] = await Promise.all([
    prisma.tenant.findUnique({ where: { slug }, select: { id: true, name: true } }),
    prisma.tenant.findFirst({
      where: { email_domain: domain },
      select: { id: true, name: true },
    }),
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  ]);

  if (slugTaken) {
    fail(`الـ slug "${slug}" مستخدم بالفعل في "${slugTaken.name}" (id: ${slugTaken.id}).`);
  }

  if (domainTaken) {
    fail(
      `الدومين "${domain}" مستخدم بالفعل في "${domainTaken.name}" (id: ${domainTaken.id}).\n` +
        `   كل سنتر لازم يكون له دومين مختلف، وإلا الإيميلات هتتلخبط.`
    );
  }

  if (emailTaken) fail(`الإيميل "${email}" موجود بالفعل.`);

  // ── 3) اعمل الهاش برّه الـ transaction (bcrypt بطيء) ─────────
  const hashed = await bcrypt.hash(CONFIG.ownerPassword, 12);

  // ── 4) التلاتة مع بعض أو ولا حاجة ───────────────────────────
  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: CONFIG.name.trim(),
        slug,
        email_domain: domain,
        is_active: true,
      },
      select: { id: true, name: true, slug: true },
    });

    const branch = await tx.branch.create({
      data: {
        tenant_id: tenant.id,
        name: CONFIG.branchName.trim(),
        address: CONFIG.branchAddress,
        phone: CONFIG.branchPhone,
        is_active: true,
      },
      select: { id: true, name: true },
    });

    // ملاحظة: الـ owner مبياخدش صف في user_branch_access.
    // وصوله لكل فروع سنتره ضمني (FULL_ACCESS_ROLES).
    const owner = await tx.user.create({
      data: {
        tenant_id: tenant.id,
        name: CONFIG.ownerName.trim(),
        email,
        password: hashed,
        role: "owner",
        branch_id: branch.id,
        is_active: true,
      },
      select: { id: true, name: true, email: true },
    });

    return { tenant, branch, owner };
  });

  // ── 5) الخلاصة ──────────────────────────────────────────────
  console.log(`
✅ تم إنشاء السنتر

   السنتر:   ${result.tenant.name}  (id: ${result.tenant.id}، slug: ${result.tenant.slug})
   الدومين:  @${domain}
   الفرع:    ${result.branch.name}  (id: ${result.branch.id})

   بيانات الدخول:
     البريد:   ${result.owner.email}
     الباسورد: ${CONFIG.ownerPassword}

   ⚠️  غيّر الباسورد بعد أول دخول.
   ⚠️  أي حساب جديد في السنتر ده لازم يكون على @${domain}.
`);
};

main()
  .catch((err) => {
    if (err.code === "P2002") {
      fail(`قيمة مكررة على الحقل: ${err.meta?.target}`);
    }
    console.error("\n❌ فشل الإنشاء — مفيش حاجة اتكتبت:\n", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());