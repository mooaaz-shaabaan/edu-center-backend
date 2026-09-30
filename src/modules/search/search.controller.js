// src/modules/search/search.controller.js
const prisma = require("../../config/db");
const { tenantWhere, resolveTenantId } = require("../../core/tenant");

// ── GET /api/search?q=... ─────────────────────────────────
const globalSearch = async (req, res, next) => {
  try {
    const { q } = req.validated.query;
    const query = q.trim();

    // فلتر السنتر — كل بحث لازم يكون جوه سنتر اليوزر
    const tw = tenantWhere(req);

    // ── دور على الطالب (جوه السنتر بس) ───────────────────
    const student = await prisma.student.findFirst({
      where: {
        ...tw, // ← الفلتر بالسنتر
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { phone: { contains: query } },
          { parent_phone: { contains: query } },
          { portal_code: query },
          { qr_code: query },
        ],
      },
      select: { id: true },
    });

    if (student) {
      return getStudentFullData(req, student.id, res, next);
    }

    // لو مش لاقي طالب — دور برقم الإيصال (جوه السنتر بس)
    const payment = await prisma.payment.findFirst({
      where: {
        ...tw, // ← الفلتر بالسنتر
        receipt_number: { contains: query, mode: "insensitive" },
      },
      select: { student_id: true },
    });

    if (!payment || !payment.student_id) {
      return res.status(404).json({ success: false, message: "No results found." });
    }

    return getStudentFullData(req, payment.student_id, res, next);
  } catch (err) {
    next(err);
  }
};

// ── Helper: جيب كل بيانات الطالب ─────────────────────────
const getStudentFullData = async (req, studentId, res, next) => {
  try {
    const tenantId = resolveTenantId(req);

    // تأكيد إضافي: الطالب لازم من نفس السنتر قبل ما نجمّع بياناته
    const studentCheck = await prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, tenant_id: true },
    });
    if (!studentCheck || (tenantId !== null && studentCheck.tenant_id !== tenantId)) {
      return res.status(404).json({ success: false, message: "No results found." });
    }

    const [student, payments, attendance, installments, grades] = await Promise.all([
      prisma.student.findUnique({
        where: { id: studentId },
        include: {
          branch: { select: { id: true, name: true } },
          enrollments: {
            include: { course: { select: { id: true, name: true, price: true } } },
          },
        },
      }),
      prisma.payment.findMany({
        where: { student_id: studentId },
        orderBy: { paid_at: "desc" },
        select: {
          id: true, receipt_number: true, amount: true,
          paid_at: true, notes: true,
          shift: { select: { id: true, opened_at: true } },
        },
      }),
      prisma.attendance.findMany({
        where: { student_id: studentId },
        orderBy: { date: "desc" },
        take: 30,
        select: { id: true, date: true, status: true, method: true },
      }),
      prisma.installment.findMany({
        where: { student_id: studentId },
        orderBy: { due_date: "asc" },
        select: {
          id: true, amount: true, due_date: true, paid_at: true, status: true,
          enrollment: { include: { course: { select: { id: true, name: true } } } },
        },
      }),
      prisma.studentGrade.findMany({
        where: { student_id: studentId },
        include: { exam: { select: { title: true, exam_date: true } } },
      }),
    ]);

    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const presentCount = attendance.filter((a) => a.status === "present").length;
    const attendancePercentage =
      attendance.length > 0
        ? `${((presentCount / attendance.length) * 100).toFixed(1)}%`
        : "0%";
    const overdueInstallments = installments.filter(
      (i) => i.status !== "paid" && new Date(i.due_date) < new Date()
    ).length;

    res.json({
      success: true,
      data: {
        student: {
          id: student.id,
          name: student.name,
          phone: student.phone,
          parent_phone: student.parent_phone,
          portal_code: student.portal_code,
          branch: student.branch,
          is_active: student.is_active,
          enrollments: student.enrollments,
        },
        summary: {
          total_paid: totalPaid,
          attendance_percentage: attendancePercentage,
          overdue_installments: overdueInstallments,
        },
        payments,
        attendance,
        installments,
        grades,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { globalSearch };