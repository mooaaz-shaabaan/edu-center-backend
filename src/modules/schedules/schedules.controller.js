// src/modules/schedules/schedules.controller.js
const prisma = require("../../config/db");

// ═══════════════════════════════════════════
// SCHEDULES
// ═══════════════════════════════════════════

// ── GET /api/schedules ────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { branch_id, course_id } = req.query;

    const where = {};
    if (course_id) where.course_id = parseInt(course_id);
    if (branch_id) {
      where.course = { branch_id: parseInt(branch_id) };
    }

    const schedules = await prisma.schedule.findMany({
      where,
      orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }],
      include: {
        course: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: schedules });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/schedules ───────────────────────────────────
const create = async (req, res, next) => {
  try {
    const { course_id, room_id, day_of_week, start_time, end_time, teacher } = req.body;

    if (!course_id || !room_id || day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        message: "course_id, room_id, day_of_week, start_time, end_time are required.",
      });
    }

    // Conflict Detection — نفس الأوضة + نفس اليوم + توقيت متداخل
    // تحقق من التكرار الكامل أولاً
  const duplicate = await prisma.schedule.findFirst({
    where: {
      room_id: parseInt(room_id),
      day_of_week: parseInt(day_of_week),
      start_time,
      end_time,
      teacher: teacher || null,
    },
  });

  if (duplicate) {
    return res.status(409).json({
      success: false,
      message: "This schedule already exists.",
      data: duplicate,
    });
  }

  // Conflict Detection — نفس الأوضة + نفس اليوم + توقيت متداخل
  const conflicts = await prisma.schedule.findMany({
    where: {
      room_id: parseInt(room_id),
      day_of_week: parseInt(day_of_week),
      AND: [
        { start_time: { lt: end_time } },
        { end_time: { gt: start_time } },
      ],
    },
    include: {
      course: { select: { id: true, name: true } },
    },
  });

    // سجّل الحصة
    const schedule = await prisma.schedule.create({
      data: {
        course_id: parseInt(course_id),
        room_id: parseInt(room_id),
        day_of_week: parseInt(day_of_week),
        start_time,
        end_time,
        teacher: teacher || null,
      },
      include: {
        course: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
      },
    });

    // لو في تعارض — سجّله وبعت إشعار للأدمن (مش بيمنع التسجيل)
    if (conflicts.length > 0) {
      for (const conflict of conflicts) {
        await prisma.scheduleConflict.create({
          data: {
            schedule_a_id: conflict.id,
            schedule_b_id: schedule.id,
          },
        });
      }

      return res.status(201).json({
        success: true,
        message: "Schedule created with conflicts detected.",
        data: schedule,
        conflicts: conflicts.map((c) => ({
          id: c.id,
          course: c.course.name,
          start_time: c.start_time,
          end_time: c.end_time,
        })),
      });
    }

    res.status(201).json({
      success: true,
      message: "Schedule created successfully.",
      data: schedule,
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/schedules/:id ────────────────────────────────
const update = async (req, res, next) => {
  try {
    const { course_id, room_id, day_of_week, start_time, end_time, teacher } = req.body;

    const schedule = await prisma.schedule.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(course_id && { course_id: parseInt(course_id) }),
        ...(room_id && { room_id: parseInt(room_id) }),
        ...(day_of_week !== undefined && { day_of_week: parseInt(day_of_week) }),
        ...(start_time && { start_time }),
        ...(end_time && { end_time }),
        ...(teacher !== undefined && { teacher }),
      },
      include: {
        course: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, message: "Schedule updated.", data: schedule });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/schedules/:id ─────────────────────────────
const remove = async (req, res, next) => {
  try {
    await prisma.schedule.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true, message: "Schedule deleted." });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/schedules/conflicts (Admin فقط) ──────────────
const getConflicts = async (req, res, next) => {
  try {
    const conflicts = await prisma.scheduleConflict.findMany({
      where: { status: "unresolved" },
      include: {
        schedule_a: {
          include: { course: { select: { id: true, name: true } }, room: { select: { id: true, name: true } } },
        },
        schedule_b: {
          include: { course: { select: { id: true, name: true } }, room: { select: { id: true, name: true } } },
        },
      },
      orderBy: { noted_at: "desc" },
    });

    res.json({ success: true, data: conflicts });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════
// EXAMS
// ═══════════════════════════════════════════

// ── GET /api/schedules/exams ──────────────────────────────
const getExams = async (req, res, next) => {
  try {
    const { course_id } = req.query;
    const where = {};
    if (course_id) where.course_id = parseInt(course_id);

    // الامتحانات القادمة بس
    where.exam_date = { gte: new Date() };

    const exams = await prisma.exam.findMany({
      where,
      orderBy: { exam_date: "asc" },
      include: {
        course: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: exams });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/schedules/exams ─────────────────────────────
const createExam = async (req, res, next) => {
  try {
    const { course_id, title, exam_date, location, notes } = req.body;

    if (!course_id || !title || !exam_date) {
      return res.status(400).json({
        success: false,
        message: "course_id, title, and exam_date are required.",
      });
    }

    const exam = await prisma.exam.create({
      data: {
        course_id: parseInt(course_id),
        title,
        exam_date: new Date(exam_date),
        location: location || null,
        notes: notes || null,
      },
      include: {
        course: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({
      success: true,
      message: "Exam created successfully.",
      data: exam,
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/schedules/exams/:id ──────────────────────────
const updateExam = async (req, res, next) => {
  try {
    const { title, exam_date, location, notes } = req.body;

    const exam = await prisma.exam.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(title && { title }),
        ...(exam_date && { exam_date: new Date(exam_date) }),
        ...(location !== undefined && { location }),
        ...(notes !== undefined && { notes }),
      },
      include: {
        course: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, message: "Exam updated.", data: exam });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/schedules/exams/:id ───────────────────────
const removeExam = async (req, res, next) => {
  try {
    await prisma.exam.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true, message: "Exam deleted." });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll, create, update, remove, getConflicts,
  getExams, createExam, updateExam, removeExam,
};
