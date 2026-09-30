// src/modules/auth/auth.controller.js
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const prisma = require("../../config/db");
const {
  startSession,
  hasOpenSession,
  endSession,
  closeUserStreams,
} = require("../../core/session");
const { notify } = require("../../core/sse");

// ── Helpers: توليد الـ Tokens ─────────────────────────────
const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      branch_id: user.branch_id,
      tenant_id: user.tenant_id,
      tenant_slug: user.tenant?.slug || null,
      tv: user.token_version,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "15m",
      issuer: process.env.JWT_ISSUER || "edu-center",
      audience: process.env.JWT_AUDIENCE || "edu-center-app",
    },
  );
};

const generateRefreshToken = () => {
  const token = crypto.randomBytes(40).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, hash };
};

// ← hash حقيقي بيتعمل مرة واحدة وقت تشغيل السيرفر.
// القديم كان 58 حرف (مش hash صالح)، فـ bcrypt كان بيرجع false في أقل من 1ms
// بدل ~300ms، وده كان بيكشف الإيميل موجود ولا لأ من سرعة الرد.
// لازم الرقم (12) يبقى نفس الـ cost اللي الباسوردات بتتعمل بيه hash.
const DUMMY_HASH = bcrypt.hashSync("__timing_dummy__", 12);

// ── Helpers: تنسيق صلاحيات الفروع ─────────────────────────
const parseFeatures = (str) =>
  (str || "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

const formatBranchAccess = (rows = []) =>
  rows.map((ba) => ({
    branch_id: ba.branch_id,
    branch_name: ba.branch?.name ?? "",
    features: parseFeatures(ba.features),
  }));

// الـ select المشترك لصلاحيات الفروع
const BRANCH_ACCESS_SELECT = {
  select: {
    branch_id: true,
    features: true,
    branch: { select: { name: true } },
  },
};

// ── POST /api/auth/login ──────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, password } = req.validated.body;

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: {
        tenant: {
          select: { id: true, slug: true, is_active: true, email_domain: true },
        },
        branch_access: BRANCH_ACCESS_SELECT,
      },
    });

    // نفّذ bcrypt دايمًا (منع timing attack)
    const hashToCompare = user ? user.password : DUMMY_HASH;
    const isMatch = await bcrypt.compare(password, hashToCompare);

    // ① إيميل أو باسورد غلط → نفس الرسالة العامة
    //    (عشان محدش يعرف من الرسالة إن الإيميل ده موجود)
    if (!user || !isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    // ② البيانات صح بس الحساب متوقف → رسالة واضحة
    //    (بتظهر بس لحد عارف الباسورد الصح، فمش بتكشف حاجة لحد تاني)
    if (!user.is_active) {
      const contact =
        user.role === "owner" || user.role === "super_admin"
          ? "الدعم الفني"
          : "مدير السنتر";
      return res.status(403).json({
        success: false,
        code: user.archived_at ? "ACCOUNT_ARCHIVED" : "ACCOUNT_INACTIVE",
        message: user.archived_at
          ? `هذا الحساب مؤرشف. تواصل مع ${contact}.`
          : `هذا الحساب غير مفعّل. تواصل مع ${contact} لتفعيله.`,
      });
    }

    // ── تحقق إن السنتر نفسه شغّال (ماعدا الـ super_admin) ──
    if (user.role !== "super_admin") {
      if (!user.tenant || !user.tenant.is_active) {
        return res.status(403).json({
          success: false,
          message: "Your center account is inactive. Please contact support.",
        });
      }
    }

    // ── جلسة واحدة بس للحساب ─────────────────────────────
    // (بعد التأكد من الباسورد — محدش يعرف إن الحساب مفتوح من غير الباسورد)
    const tokenVersion = await startSession(user.id);
    if (tokenVersion === null) {
      return res.status(409).json({
        success: false,
        code: "ACCOUNT_IN_USE",
        message:
          "هذا الحساب مفتوح على جهاز آخر. إذا أُغلق البرنامج فجأة، انتظر 5 دقائق أو اطلب من المدير تسجيل خروجك.",
      });
    }
    user.token_version = tokenVersion; // التوكن بالنسخة الجديدة

    // ⚠ كان بيبعت shifts_updated بس — فشاشة المستخدمين ماكانتش بتعرف
    //   إن حد دخل. من التطبيق كانت بتتحدث بالصدفة (فتح جلسة + اتصال SSE
    //   بيطلّعوا أحداث تانية)، لكن أي لوجن من غير الأحداث دي كان بيعدّي
    //   من غير ما يظهر. endMySession و forceLogout بيبعتوا الاتنين أصلاً.
    notify("shifts_updated", {}, user.tenant_id); // حالة "متصل" عند المديرين
    notify("users_updated", {}, user.tenant_id); // شاشة المستخدمين

    const accessToken = generateAccessToken(user);
    const { token: refreshToken, hash: refreshHash } = generateRefreshToken();

    const refreshExpiresAt = new Date();
    refreshExpiresAt.setDate(refreshExpiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        token_hash: refreshHash,
        user_id: user.id,
        expires_at: refreshExpiresAt,
        ip_address: req.ip,
      },
    });

    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/api/auth",
    });

    res.json({
      success: true,
      message: "Login successful.",
      data: {
        accessToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          branch_id: user.branch_id,
          tenant_id: user.tenant_id,
          tenant_slug: user.tenant?.slug || null,
          tenant_email_domain: user.tenant?.email_domain || null, // ← جديد
          branch_access: formatBranchAccess(user.branch_access),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/refresh ────────────────────────────────
const refresh = async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token;
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "No refresh token." });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const stored = await prisma.refreshToken.findUnique({
      where: { token_hash: tokenHash },
      include: {
        user: {
          include: {
            tenant: { select: { id: true, slug: true, is_active: true } },
          },
        },
      },
    });

    if (
      !stored ||
      stored.revoked_at ||
      stored.expires_at < new Date() ||
      !stored.user?.is_active
    ) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid refresh token." });
    }

    if (stored.user.role !== "super_admin") {
      if (!stored.user.tenant || !stored.user.tenant.is_active) {
        return res
          .status(403)
          .json({ success: false, message: "Center inactive." });
      }
    }

    // ← الجلسة لازم تكون لسه مفتوحة (مش خرج / مش عدّى 5 دقايق من غير اتصال)
    if (!hasOpenSession(stored.user.last_seen_at)) {
      return res.status(401).json({
        success: false,
        code: "SESSION_ENDED",
        message: "Session ended. Please login again.",
      });
    }

    const { token: newRefresh, hash: newHash } = generateRefreshToken();
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + 7);

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revoked_at: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          token_hash: newHash,
          user_id: stored.user_id,
          expires_at: newExpiresAt,
          ip_address: req.ip,
        },
      }),
    ]);

    const accessToken = generateAccessToken(stored.user);

    res.cookie("refresh_token", newRefresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/api/auth",
    });

    res.json({ success: true, data: { accessToken } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/auth/me ──────────────────────────────────────
const me = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branch_id: true,
        tenant_id: true,
        is_active: true,
        created_at: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            email_domain: true, // ← 1
          },
        },
        branch_access: BRANCH_ACCESS_SELECT,
      },
    });

    if (!user || !user.is_active) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    const { branch_access, tenant, ...rest } = user;

    res.json({
      success: true,
      data: {
        ...rest,
        tenant_slug: tenant?.slug || null,
        tenant_email_domain: tenant?.email_domain || null, // ← 2
        tenant,
        branch_access: formatBranchAccess(branch_access),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/logout ─────────────────────────────────
const logout = async (req, res, next) => {
  try {
    // ⚠ كان بيلغي الـ refresh token اللي في الكوكي وبس.
    //
    //   يعني بعد الخروج:
    //   · الـ access token يفضل صالح لحد ما ينتهي — ٧ أيام
    //     بإعداد JWT_EXPIRES_IN الحالي. حد ياخد التوكن من جهاز
    //     الاستقبال يستخدمه عادي بعد ما الموظف خرج.
    //   · الجلسة تفضل مفتوحة (last_seen_at زي ما هي)، فالموظف
    //     مايقدرش يدخل تاني قبل ٥ دقايق — "الحساب مفتوح على جهاز آخر".
    //
    //   endSession بيعمل التلاتة: يزوّد token_version (كل التوكنات
    //   الحالية تبطل فوراً)، يفضّي last_seen_at، ويلغي كل الـ
    //   refresh tokens مش بتاعة الكوكي بس.
    //
    //   ملحوظة: البرنامج بينادي /session/end قبل ده، فالنداء هنا
    //   ممكن يرجّع 401 (التوكن بطل) — وده متوقع ومتعامَل معاه في
    //   _sessionIgnoredPaths في الفلاتر. الأهم إن أي عميل بينادي
    //   /auth/logout لوحده يقفل الجلسة فعلاً.
    await endSession(req.user.id);
    closeUserStreams(req.user.id);

    notify("shifts_updated", {}, req.user.tenant_id);
    notify("users_updated", {}, req.user.tenant_id);

    res.clearCookie("refresh_token", { path: "/api/auth" });
    res.json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/logout-all ─────────────────────────────
const logoutAll = async (req, res, next) => {
  try {
    // نفس المنطق — بس كان ناقصه تفضية last_seen_at، فالجلسة
    // كانت بتفضل "مفتوحة" والحساب مايقدرش يدخل قبل ٥ دقايق
    await endSession(req.user.id);
    closeUserStreams(req.user.id);

    notify("shifts_updated", {}, req.user.tenant_id);
    notify("users_updated", {}, req.user.tenant_id);

    res.clearCookie("refresh_token", { path: "/api/auth" });
    res.json({ success: true, message: "Logged out from all devices." });
  } catch (err) {
    next(err);
  }
};

module.exports = { login, refresh, me, logout, logoutAll };
