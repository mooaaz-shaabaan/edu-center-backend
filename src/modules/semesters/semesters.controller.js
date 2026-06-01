// src/modules/semesters/semesters.controller.js
const prisma = require("../../config/db");

// ═══════════════════════════════════════════
// SEMESTERS
// ═══════════════════════════════════════════

// GET /api/semesters
const getAll = async (req, res, next) => {
  try {
    const { branch_id } = req.query;
    const where = {};
    if (branch_id) where.branch_id = parseInt(branch_id);

    const semesters = await prisma.semester.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.json({ success: true, data: semesters });
  } catch (err) { next(err); }
};

// POST /api/semesters
const create = async (req, res, next) => {
  try {
    const { name, year, branch_id } = req.body;

    if (!name || !year || !branch_id) {
      return res.status(400).json({
        success: false,
        message: "name, year, and branch_id are required.",
      });
    }

    const semester = await prisma.semester.create({
      data: {
        name,
        year,
        branch_id: parseInt(branch_id),
      },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.status(201).json({ success: true, message: "Semester created.", data: semester });
  } catch (err) { next(err); }
};

// PUT /api/semesters/:id
const update = async (req, res, next) => {
  try {
    const { name, year, is_active } = req.body;

    const semester = await prisma.semester.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(name && { name }),
        ...(year && { year }),
        ...(is_active !== undefined && { is_active }),
      },
    });

    res.json({ success: true, message: "Semester updated.", data: semester });
  } catch (err) { next(err); }
};

// DELETE /api/semesters/:id
const remove = async (req, res, next) => {
  try {
    await prisma.semester.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true, message: "Semester deleted." });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════
// ENROLLMENTS
// ═══════════════════════════════════════════

// POST /api/enrollments — تسجيل طالب في مادة أو أكتر
const enroll = async (req, res, next) => {
  try {
    const { student_id, course_ids, semester_id, start_date } = req.body;

    if (!student_id || !course_ids || !Array.isArray(course_ids) || course_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "student_id and course_ids array are required.",
      });
    }

    // سجّل الطالب في كل مادة
    const enrollments = await Promise.all(
      course_ids.map((course_id) =>
        prisma.enrollment.create({
          data: {
            student_id: parseInt(student_id),
            course_id: parseInt(course_id),
            semester_id: semester_id ? parseInt(semester_id) : null,
            start_date: start_date ? new Date(start_date) : new Date(),
            sync_status: "synced",
          },
          include: {
            course: { select: { id: true, name: true } },
            semester: { select: { id: true, name: true, year: true } },
          },
        })
      )
    );

    res.status(201).json({
      success: true,
      message: `تم تسجيل الطالب في ${enrollments.length} مادة.`,
      data: enrollments,
    });
  } catch (err) { next(err); }
};

// GET /api/enrollments?student_id=
const getEnrollments = async (req, res, next) => {
  try {
    const { student_id, semester_id } = req.query;
    const where = {};
    if (student_id) where.student_id = parseInt(student_id);
    if (semester_id) where.semester_id = parseInt(semester_id);

    const enrollments = await prisma.enrollment.findMany({
      where,
      include: {
        student: { select: { id: true, name: true } },
        course: { select: { id: true, name: true } },
        semester: { select: { id: true, name: true, year: true } },
      },
      orderBy: { created_at: "desc" },
    });

    res.json({ success: true, data: enrollments });
  } catch (err) { next(err); }
};

// DELETE /api/enrollments/:id
const removeEnrollment = async (req, res, next) => {
  try {
    await prisma.enrollment.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true, message: "Enrollment removed." });
  } catch (err) { next(err); }
};

module.exports = {
  getAll, create, update, remove,
  enroll, getEnrollments, removeEnrollment,
};
