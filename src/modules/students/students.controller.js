// src/modules/students/students.controller.js
const prisma = require("../../config/db");
const { generateQRCode } = require("../../utils/qrGenerator");
const { generatePortalCode } = require("../../utils/portalCode");
const { validateEgyptianPhone } = require("../../utils/phoneValidator");

// ── GET /api/students ─────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { name, branch_id, course_id, page = 1, limit = 20 } = req.query;

const where = { is_active: true }; // ← بدل {}
    if (name) {
      where.OR = [
        { name: { contains: name, mode: "insensitive" } },
        { phone: { contains: name } },
        { parent_phone: { contains: name } },
        { portal_code: { contains: name } },
      ];
    }
    if (branch_id) where.branch_id = parseInt(branch_id);
    if (course_id) {
      where.enrollments = { some: { course_id: parseInt(course_id) } };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          name: true,
          phone: true,
          parent_phone: true,
          alt_phone: true,
          portal_code: true,
          branch_id: true,
          is_active: true,
          created_at: true,
          updated_at: true,
          sync_status: true,
          shift_id: true,
          wallet_enabled: true,
          wallet_balance: true,
          // ← photo و qr_code مش موجودين هنا عمداً
          branch: { select: { id: true, name: true } },
          enrollments: {
            include: { course: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.student.count({ where }),
    ]);

    res.json({
      success: true,
      data: students,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/students/:id ─────────────────────────────────
const getOne = async (req, res, next) => {
  try {
    const student = await prisma.student.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        branch: { select: { id: true, name: true } },
        enrollments: {
          include: { course: true, installments: true },
        },
        attendance: {
          orderBy: { date: "desc" },
          take: 10,
        },
        payments: {
          orderBy: { paid_at: "desc" },
          take: 10,
        },
      },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    res.json({ success: true, data: student });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/students ────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const { name, phone, parent_phone, alt_phone, branch_id, wallet_enabled } = req.body;

    if (!name || !phone || !parent_phone || !branch_id) {
      return res.status(400).json({
        success: false,
        message: "name, phone, parent_phone, and branch_id are required.",
      });
    }

    if (!validateEgyptianPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number. Must start with 010/011/012/015 and be 11 digits.",
      });
    }

    if (!validateEgyptianPhone(parent_phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid parent phone number. Must start with 010/011/012/015 and be 11 digits.",
      });
    }

    const portalCode = generatePortalCode();
    const qrCode = await generateQRCode(portalCode);

    const student = await prisma.student.create({
      data: {
        name,
        phone,
        parent_phone,
        alt_phone: alt_phone || null,
        branch_id: parseInt(branch_id),
        portal_code: portalCode,
        qr_code: qrCode,
        shift_id: req.body.shift_id || null,
        wallet_enabled: wallet_enabled === true || wallet_enabled === 'true',
        wallet_balance: 0,
      },
      select: {
        id: true, name: true, phone: true,
        parent_phone: true, alt_phone: true,
        portal_code: true, qr_code: true,
        branch_id: true, is_active: true,
        created_at: true, sync_status: true, shift_id: true,
        wallet_enabled: true, wallet_balance: true, // ← أضف
        branch: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: "Student created successfully.",
      data: student,
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/students/:id ─────────────────────────────────
const update = async (req, res, next) => {
  try {
    const { name, phone, parent_phone, alt_phone, branch_id, is_active, photo, wallet_enabled, wallet_balance } = req.body;

    if (phone && !validateEgyptianPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number. Must start with 010/011/012/015 and be 11 digits.",
      });
    }

    if (parent_phone && !validateEgyptianPhone(parent_phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid parent phone number.",
      });
    }

    const student = await prisma.student.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(parent_phone && { parent_phone }),
        ...(alt_phone !== undefined && { alt_phone }),
        ...(branch_id && { branch_id: parseInt(branch_id) }),
        ...(is_active !== undefined && { is_active }),
        ...(photo !== undefined && { photo }),
        ...(wallet_enabled !== undefined && { wallet_enabled }),
        ...(wallet_balance !== undefined && { wallet_balance: parseFloat(wallet_balance) }),
      },
      select: {
        id: true, name: true, phone: true,
        parent_phone: true, alt_phone: true,
        portal_code: true, branch_id: true,
        is_active: true, created_at: true,
        sync_status: true, shift_id: true,
        // ← photo و qr_code مش موجودين عمداً
        branch: { select: { id: true, name: true } },
        enrollments: {
          include: { course: { select: { id: true, name: true } } },
        },
      },
    });

    res.json({
      success: true,
      message: "Student updated successfully.",
      data: student,
    });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/students/:id (Admin فقط) ─────────────────
const remove = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.student.delete({ where: { id } });
    res.json({ success: true, message: "Student deleted successfully." });
  } catch (err) { next(err); }
};

// ── GET /api/students/:id/qr ──────────────────────────────
const getQR = async (req, res, next) => {
  try {
    const student = await prisma.student.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { qr_code: true, name: true },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    res.json({ success: true, data: { name: student.name, qr_code: student.qr_code } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/students/:id/wallet/charge ─────────────────
const chargeWallet = async (req, res, next) => {
  try {
    const { amount, shift_id } = req.body;
    const studentId = parseInt(req.params.id);

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount is required and must be greater than 0.",
      });
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }

    if (!student.wallet_enabled) {
      return res.status(400).json({
        success: false,
        message: "Wallet is not enabled for this student.",
      });
    }

    const chargeAmount = parseFloat(amount);

    // أضف رصيد للمحفظة
    const updated = await prisma.student.update({
      where: { id: studentId },
      data: { wallet_balance: { increment: chargeAmount } },
      select: { id: true, name: true, wallet_balance: true },
    });

    // سجل الدفعة في payments
    await prisma.payment.create({
      data: {
        student_id: studentId,
        amount: chargeAmount,
        shift_id: shift_id ? parseInt(shift_id) : null,
        notes: 'شحن محفظة',
        receipt_number: `W-${studentId}-${Date.now()}`, // ← أضف

      },
    });
    

    res.json({
      success: true,
      message: `تم شحن ${chargeAmount} جنيه في محفظة ${student.name}`,
      data: updated,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, getOne, create, update, remove, getQR, chargeWallet };