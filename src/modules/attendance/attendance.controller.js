// src/modules/attendance/attendance.controller.js
const prisma = require("../../config/db");

// ── GET /api/attendance ───────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { student_id, date, page = 1, limit = 20 } = req.query;

    const where = {};
    if (student_id) where.student_id = parseInt(student_id);
    if (date) {
      const d = new Date(date);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      where.date = { gte: d, lt: next };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [records, total] = await Promise.all([
      prisma.attendance.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { date: "desc" },
        include: {
          student: { select: { id: true, name: true, phone: true } },
          shift: { select: { id: true, opened_at: true } },
          course: { select: { id: true, name: true } },
        },
      }),
      prisma.attendance.count({ where }),
    ]);

    res.json({
      success: true,
      data: records,
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

// ── helpers ───────────────────────────────────────────────
const handleWalletOrCash = async (student, coursePrice, shiftId, forceCash = false) => {
  // لو forceCash → دفع نقدي حتى لو المحفظة مفعلة
  if (forceCash) {
    if (coursePrice > 0 && shiftId) {
      await prisma.payment.create({
        data: {
          student_id: student.id,
          amount: coursePrice,
          shift_id: parseInt(shiftId),
          notes: 'دفع نقدي عند الحضور',
          receipt_number: `ATT-${student.id}-${Date.now()}`, 
        },
      });
    }
    return { paymentMethod: 'cash', walletEmpty: false };
  }

  if (student.wallet_enabled) {
    if (coursePrice > 0 && student.wallet_balance >= coursePrice) {
      // خصم من المحفظة
      await prisma.student.update({
        where: { id: student.id },
        data: { wallet_balance: { decrement: coursePrice } },
      });
      return { paymentMethod: 'wallet', walletEmpty: false };
    } else if (coursePrice > 0) {
      // المحفظة فارغة
      return { paymentMethod: null, walletEmpty: true };
    }
  } else {
    // مش بمحفظة → كاش
    if (coursePrice > 0 && shiftId) {
      await prisma.payment.create({
        data: {
          student_id: student.id,
          amount: coursePrice,
          shift_id: parseInt(shiftId),
          notes: 'دفع نقدي عند الحضور',
          receipt_number: `ATT-${student.id}-${Date.now()}`, // ← أضف
        },
      });
    }
    return { paymentMethod: 'cash', walletEmpty: false };
  }

  return { paymentMethod: 'cash', walletEmpty: false };
};

// ── POST /api/attendance/qr ───────────────────────────────
const recordByQR = async (req, res, next) => {
  try {
    const { qr_content, shift_id, course_id, force_cash } = req.body;

    if (!qr_content) {
      return res.status(400).json({
        success: false,
        message: "qr_content is required.",
      });
    }

    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { portal_code: qr_content },
          { qr_code: qr_content },
        ],
      },
      include: {
        enrollments: { include: { course: true } },
      },
    });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found for this QR code.",
      });
    }

    // تأكد مسجلش حضور النهارده
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await prisma.attendance.findFirst({
      where: {
        student_id: student.id,
        course_id: course_id ? parseInt(course_id) : null,
        date: { gte: today, lt: tomorrow },
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Attendance already recorded for today.",
        data: existing,
      });
    }

    // جيب سعر الكورس
    let coursePrice = 0;
    if (course_id) {
      const enrollment = student.enrollments.find(
        e => e.course_id === parseInt(course_id)
      );
      coursePrice = enrollment?.course?.price || 0;
    }

    // handle wallet or cash
    const { paymentMethod, walletEmpty } = await handleWalletOrCash(
      student, coursePrice, shift_id, force_cash === true
    );

    // لو المحفظة فارغة → رجع للـ Flutter يعمل dialog
    if (walletEmpty) {
      return res.status(402).json({
        success: false,
        message: "wallet_empty",
        data: {
          student_id: student.id,
          student_name: student.name,
          wallet_balance: student.wallet_balance,
          course_price: coursePrice,
        },
      });
    }

    const attendance = await prisma.attendance.create({
      data: {
        student_id: student.id,
        shift_id: shift_id ? parseInt(shift_id) : null,
        course_id: course_id ? parseInt(course_id) : null,
        method: "qr",
        status: "present",
        payment_method: paymentMethod,
        sync_status: "synced",
        student_name: student.name,
        student_phone: student.phone,
      },
      include: {
        student: { select: { id: true, name: true } },
        course: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: `Attendance recorded for ${student.name}.`,
      data: attendance,
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/attendance/manual ───────────────────────────
const recordManual = async (req, res, next) => {
  try {
    const { student_id, status, notes, shift_id, course_id, force_cash } = req.body;

    if (!student_id) {
      return res.status(400).json({
        success: false,
        message: "student_id is required.",
      });
    }

    const student = await prisma.student.findUnique({
      where: { id: parseInt(student_id) },
      include: {
        enrollments: { include: { course: true } },
      },
    });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    // تأكد مسجلش حضور النهارده
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await prisma.attendance.findFirst({
      where: {
        student_id: parseInt(student_id),
        course_id: course_id ? parseInt(course_id) : null,
        date: { gte: today, lt: tomorrow },
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Attendance already recorded for today.",
        data: existing,
      });
    }

    // جيب سعر الكورس
    let coursePrice = 0;
    if (course_id) {
      const enrollment = student.enrollments.find(
        e => e.course_id === parseInt(course_id)
      );
      coursePrice = enrollment?.course?.price || 0;
    }

    // handle wallet or cash
    const { paymentMethod, walletEmpty } = await handleWalletOrCash(
      student, coursePrice, shift_id, force_cash === true
    );

    // لو المحفظة فارغة → رجع للـ Flutter يعمل dialog
    if (walletEmpty) {
      return res.status(402).json({
        success: false,
        message: "wallet_empty",
        data: {
          student_id: student.id,
          student_name: student.name,
          wallet_balance: student.wallet_balance,
          course_price: coursePrice,
        },
      });
    }

    const attendance = await prisma.attendance.create({
      data: {
        student_id: parseInt(student_id),
        shift_id: shift_id ? parseInt(shift_id) : null,
        course_id: course_id ? parseInt(course_id) : null,
        method: "manual",
        status,
        notes: notes || null,
        payment_method: paymentMethod,
        sync_status: "synced",
        student_name: student.name,
        student_phone: student.phone,
      },
      include: {
        student: { select: { id: true, name: true } },
        course: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: `Attendance recorded for ${student.name}.`,
      data: attendance,
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/attendance/sync ─────────────────────────────
const syncOffline = async (req, res, next) => {
  try {
    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({
        success: false,
        message: "records array is required.",
      });
    }

    const results = [];

    for (const record of records) {
      const { student_id, date, shift_id, course_id, method, status, notes } = record;

      const recordDate = new Date(date);
      const nextDay = new Date(recordDate);
      nextDay.setDate(nextDay.getDate() + 1);
      recordDate.setHours(0, 0, 0, 0);

      const existing = await prisma.attendance.findFirst({
        where: {
          student_id: parseInt(student_id),
          course_id: course_id ? parseInt(course_id) : null,
          date: { gte: recordDate, lt: nextDay },
        },
      });

      if (existing) {
        results.push({ student_id, status: "failed", reason: "duplicate" });
        continue;
      }

      // ← جيب الطالب عشان تاخد الاسم والتليفون
      const student = await prisma.student.findUnique({
        where: { id: parseInt(student_id) },
        select: { name: true, phone: true },
      });

      await prisma.attendance.create({
        data: {
          student_id: parseInt(student_id),
          shift_id: shift_id ? parseInt(shift_id) : null,
          course_id: course_id ? parseInt(course_id) : null,
          date: new Date(date),
          method: method || "manual",
          status: status || "present",
          notes: notes || null,
          payment_method: 'cash',
          sync_status: "synced",
          student_name: student?.name || null, // ← أضف
          student_phone: student?.phone || null, // ← أضف
        },
      });

      results.push({ student_id, status: "synced" });
    }

    res.json({
      success: true,
      message: "Sync completed.",
      data: results,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/attendance/summary ───────────────────────────
const getSummary = async (req, res, next) => {
  try {
    const { student_id, days = 7 } = req.query;

    const from = new Date();
    from.setDate(from.getDate() - parseInt(days));

    const where = { date: { gte: from } };
    if (student_id) where.student_id = parseInt(student_id);

    const records = await prisma.attendance.findMany({
      where,
      include: {
        student: { select: { id: true, name: true, portal_code: true } },
        course: { select: { id: true, name: true } },
      },
    });

    const summary = {};
    for (const record of records) {
      // ← تجاهل لو الطالب اتحذف
      if (!record.student) continue;
      
      const id = record.student.id;
      if (!summary[id]) {
        summary[id] = {
          student: record.student,
          present: 0,
          absent: 0,
          late: 0,
        };
      }
      summary[id][record.status]++;
    }

    res.json({
      success: true,
      data: Object.values(summary),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, recordByQR, recordManual, syncOffline, getSummary };