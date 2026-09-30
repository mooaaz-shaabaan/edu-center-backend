// src/modules/session/session.controller.js
const prisma = require("../../config/db");
const { notify, notifyUser } = require("../../core/sse");
const {
  HEARTBEAT_INTERVAL_MS,
  touchSession,
  endSession,
  closeUserStreams,
} = require("../../core/session");
const { getAllowedBranchIds } = require("../../core/branchScope");
const { closeShiftWithTotals } = require("../shifts/shifts.service");

const MANAGER_ROLES = ["admin", "owner", "super_admin"];

// ── POST /api/session/heartbeat ───────────────────────────
// البرنامج بيبعتها كل دقيقة وهو مفتوح
const heartbeat = async (req, res, next) => {
  try {
    const ok = await touchSession(req.user.id, req.user.tokenVersion);
    if (!ok) {
      // الجلسة اتقفلت في نفس اللحظة (خروج إجباري مثلاً)
      return res.status(401).json({
        success: false,
        code: "SESSION_ENDED",
        message: "Session ended. Please login again.",
      });
    }
    res.json({ success: true, data: { interval_ms: HEARTBEAT_INTERVAL_MS } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/session/end ─────────────────────────────────
// قفل البرنامج من X، أو آخر خطوة في تسجيل الخروج.
// الشيفت مش بيتقفل هنا (تسجيل الخروج بيقفله قبلها بـ /shifts/close)
const endMySession = async (req, res, next) => {
  try {
    await endSession(req.user.id);
    closeUserStreams(req.user.id);
    notify("shifts_updated", {}, req.user.tenant_id); // حالة "متصل" عند المديرين
    notify("users_updated", {}, req.user.tenant_id); // شاشة المستخدمين
    res.json({ success: true, message: "Session ended." });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/session/force-logout ────────────────────────
// body: { user_id } أو { shift_id } (صاحب الشيفت)
//   owner / super_admin → أي حد في السنتر (غير نفسه)
//   admin              → الريسبشن اللي في فروعه بس
// بيقفل شيفت الموظف المفتوح (لو فيه) + يخرّجه فوراً
const forceLogout = async (req, res, next) => {
  try {
    const me = req.user;
    const { user_id, shift_id } = req.validated.body;

    if (!MANAGER_ROLES.includes(me.role)) {
      return res.status(403).json({
        success: false,
        message: "غير مسموح لك بتسجيل خروج المستخدمين.",
      });
    }

    const notFound = () =>
      res.status(404).json({ success: false, message: "User not found." });

    // shift_id → صاحب الشيفت (في نفس السنتر)
    let targetId = user_id;
    if (!targetId) {
      const byShift = await prisma.shift.findFirst({
        where: { id: shift_id, tenant_id: me.tenant_id },
        select: { user_id: true },
      });
      if (!byShift) return notFound();
      targetId = byShift.user_id;
    }

    if (targetId === me.id) {
      return res.status(400).json({
        success: false,
        message: "لا يمكنك تسجيل خروج نفسك من هنا.",
      });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        role: true,
        tenant_id: true,
        branch_id: true,
        branch_access: { select: { branch_id: true } },
      },
    });

    if (!target) return notFound();
    if (me.role !== "super_admin" && target.tenant_id !== me.tenant_id) {
      return notFound();
    }

    if (me.role === "admin") {
      if (target.role !== "receptionist") {
        return res.status(403).json({
          success: false,
          message: "الأدمن يستطيع تسجيل خروج موظفي الاستقبال فقط.",
        });
      }

      // الموظف لازم يكون في فرع من فروع الأدمن
      const openShift = await prisma.shift.findFirst({
        where: { user_id: targetId, closed_at: null },
        select: { branch_id: true },
      });
      const allowed = getAllowedBranchIds(me);
      const targetBranches = [
        target.branch_id,
        openShift?.branch_id,
        ...target.branch_access.map((a) => a.branch_id),
      ].filter((b) => b != null);

      if (!targetBranches.some((b) => allowed.includes(b))) return notFound();
    }

    // ← قفل الشيفت + إنهاء الجلسة: مع بعض أو ولا حاجة
    const closedShift = await prisma.$transaction(async (tx) => {
      const open = await tx.shift.findFirst({
        where: { user_id: targetId, closed_at: null },
      });
      const closed = open ? await closeShiftWithTotals(tx, open, me.id) : null;
      await endSession(targetId, tx);
      return closed;
    });

    // البرنامج عند الموظف يرجع لشاشة الدخول فوراً
    notifyUser(targetId, "force_logout", {});
    closeUserStreams(targetId);

    notify("shifts_updated", {}, target.tenant_id);
    notify("users_updated", {}, target.tenant_id); // شاشة المستخدمين
    if (closedShift) notify("payments_updated", {}, target.tenant_id);

    res.json({
      success: true,
      message: "User logged out.",
      data: { closed_shift: closedShift },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { heartbeat, endMySession, forceLogout };
