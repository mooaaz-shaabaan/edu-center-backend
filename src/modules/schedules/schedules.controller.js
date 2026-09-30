// src/modules/schedules/schedules.controller.js
const prisma = require("../../config/db");
const {
  tenantWhere,
  requireTenantId,
  assertSameTenant,
} = require("../../core/tenant");

// Helpers: الكورس/الأوضة لازم من نفس السنتر
const assertCourseInTenant = async (courseId, tenantId) => {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, tenant_id: true },
  });
  if (!course || course.tenant_id !== tenantId) {
    const err = new Error("Course not found in this center.");
    err.status = 400;
    throw err;
  }
};

const assertRoomInTenant = async (roomId, tenantId) => {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, tenant_id: true },
  });
  if (!room || room.tenant_id !== tenantId) {
    const err = new Error("Room not found in this center.");
    err.status = 400;
    throw err;
  }
};

// ── GET /api/schedules ────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { branch_id, course_id } = req.validated.query;

    const where = { ...tenantWhere(req) };
    if (course_id) where.course_id = course_id;
    if (branch_id) where.course = { branch_id };

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
    const { course_id, room_id, day_of_week, start_time, end_time, teacher } =
      req.validated.body;
    const tenantId = requireTenantId(req);

    // الكورس والأوضة لازم من نفس السنتر
    await assertCourseInTenant(course_id, tenantId);
    await assertRoomInTenant(room_id, tenantId);

    // تحقق من التكرار الكامل (جوه نفس السنتر)
    const duplicate = await prisma.schedule.findFirst({
      where: {
        tenant_id: tenantId,
        room_id,
        day_of_week,
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

    // Conflict Detection — نفس الأوضة + نفس اليوم + توقيت متداخل (جوه السنتر)
    const conflicts = await prisma.schedule.findMany({
      where: {
        tenant_id: tenantId,
        room_id,
        day_of_week,
        AND: [
          { start_time: { lt: end_time } },
          { end_time: { gt: start_time } },
        ],
      },
      include: { course: { select: { id: true, name: true } } },
    });

    // سجّل الحصة + التعارضات (لو فيه) في transaction
    const schedule = await prisma.$transaction(async (tx) => {
      const created = await tx.schedule.create({
        data: {
          tenant_id: tenantId, // ← الختم
          course_id,
          room_id,
          day_of_week,
          start_time,
          end_time,
          teacher: teacher || null,
        },
        include: {
          course: { select: { id: true, name: true } },
          room: { select: { id: true, name: true } },
        },
      });

      if (conflicts.length > 0) {
        await tx.scheduleConflict.createMany({
          data: conflicts.map((c) => ({
            tenant_id: tenantId,
            schedule_a_id: c.id,
            schedule_b_id: created.id,
          })),
        });
      }

      return created;
    });

    if (conflicts.length > 0) {
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
    const id = req.validated.params.id;
    const { course_id, room_id, day_of_week, start_time, end_time, teacher } =
      req.validated.body;

    const existing = await prisma.schedule.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, existing);

    if (course_id !== undefined)
      await assertCourseInTenant(course_id, existing.tenant_id);
    if (room_id !== undefined)
      await assertRoomInTenant(room_id, existing.tenant_id);

    const schedule = await prisma.schedule.update({
      where: { id },
      data: {
        ...(course_id !== undefined && { course_id }),
        ...(room_id !== undefined && { room_id }),
        ...(day_of_week !== undefined && { day_of_week }),
        ...(start_time !== undefined && { start_time }),
        ...(end_time !== undefined && { end_time }),
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
    const id = req.validated.params.id;

    const existing = await prisma.schedule.findUnique({
      where: { id },
      select: { id: true, tenant_id: true },
    });
    assertSameTenant(req, existing);

    // امسح التعارضات المرتبطة الأول
    await prisma.$transaction([
      prisma.scheduleConflict.deleteMany({
        where: { OR: [{ schedule_a_id: id }, { schedule_b_id: id }] },
      }),
      prisma.schedule.delete({ where: { id } }),
    ]);

    res.json({ success: true, message: "Schedule deleted." });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/schedules/conflicts (Admin فقط) ──────────────
const getConflicts = async (req, res, next) => {
  try {
    const conflicts = await prisma.scheduleConflict.findMany({
      where: { ...tenantWhere(req), status: "unresolved" },
      include: {
        schedule_a: {
          include: {
            course: { select: { id: true, name: true } },
            room: { select: { id: true, name: true } },
          },
        },
        schedule_b: {
          include: {
            course: { select: { id: true, name: true } },
            room: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { noted_at: "desc" },
    });

    res.json({ success: true, data: conflicts });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAll, create, update, remove, getConflicts };
