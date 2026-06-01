// src/modules/search/search.controller.js
const prisma = require("../../config/db");

// ── GET /api/search?q=... ─────────────────────────────────
const globalSearch = async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters.",
      });
    }

    const query = q.trim();

    // ── دور على الطالب بكل الطرق ─────────────────────────
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { phone: { contains: query } },
          { parent_phone: { contains: query } },
          { portal_code: query },
          { qr_code: query },
        ],
      },
      include: {
        branch: { select: { id: true, name: true } },
      },
    });

    // لو مش لاقي طالب — دور برقم الإيصال
    if (!student) {
      const payment = await prisma.payment.findFirst({
        where: { receipt_number: { contains: query, mode: "insensitive" } },
        include: {
          student: {
            include: { branch: { select: { id: true, name: true } } },
          },
        },
      });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message: "No results found.",
        });
      }

      // جيب كل بيانات الطالب اللي اتلاقى من الإيصال
      return getStudentFullData(payment.student.id, res, next);
    }

    return getStudentFullData(student.id, res, next);
  } catch (err) {
    next(err);
  }
};

// ── Helper: جيب كل بيانات الطالب ─────────────────────────
const getStudentFullData = async (studentId, res, next) => {
  try {
    const [student, payments, attendance, installments, grades] = await Promise.all([
      // بيانات الطالب + الكورسات
      prisma.student.findUnique({
        where: { id: studentId },
        include: {
          branch: { select: { id: true, name: true } },
          enrollments: {
            include: {
              course: { select: { id: true, name: true, price: true } },
            },
          },
        },
      }),

      // سجل الدفعات
      prisma.payment.findMany({
        where: { student_id: studentId },
        orderBy: { paid_at: "desc" },
        select: {
          id: true,
          receipt_number: true,
          amount: true,
          paid_at: true,
          notes: true,
          shift: { select: { id: true, opened_at: true } },
        },
      }),

      // سجل الحضور (آخر 30)
      prisma.attendance.findMany({
        where: { student_id: studentId },
        orderBy: { date: "desc" },
        take: 30,
        select: {
          id: true,
          date: true,
          status: true,
          method: true,
        },
      }),

      // الأقساط
      prisma.installment.findMany({
        where: { student_id: studentId },
        orderBy: { due_date: "asc" },
        select: {
          id: true,
          amount: true,
          due_date: true,
          paid_at: true,
          status: true,
          enrollment: {
            include: { course: { select: { id: true, name: true } } },
          },
        },
      }),

      // الدرجات
      prisma.studentGrade.findMany({
        where: { student_id: studentId },
        include: {
          exam: { select: { title: true, exam_date: true } },
        },
      }),
    ]);

    // احسب إجماليات
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
