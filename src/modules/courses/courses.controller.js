const prisma = require("../../config/db");

const getCourses = async (req, res, next) => {
  try {
    const { branch_id } = req.query;
    const where = { is_active: true };
    if (branch_id) where.branch_id = parseInt(branch_id);

    const courses = await prisma.course.findMany({
      where,
      orderBy: { created_at: "desc" },
      include: { branch: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: courses });
  } catch (err) { next(err); }
};

const createCourse = async (req, res, next) => {
  try {
    const { name, description, price, branch_id } = req.body;
    if (!name || !price || !branch_id) {
      return res.status(400).json({ success: false, message: "name, price, and branch_id are required." });
    }

    const course = await prisma.course.create({
      data: {
        name,
        description: description || null,
        price: parseFloat(price),
        branch_id: parseInt(branch_id),
      },
      include: { branch: { select: { id: true, name: true } } },
    });
    res.status(201).json({ success: true, message: "Course created.", data: course });
  } catch (err) { next(err); }
};

const updateCourse = async (req, res, next) => {
  try {
    const { name, description, price, is_active } = req.body;
    const course = await prisma.course.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(price && { price: parseFloat(price) }),
        ...(is_active !== undefined && { is_active }),
      },
    });
    res.json({ success: true, message: "Course updated.", data: course });
  } catch (err) { next(err); }
};

const deleteCourse = async (req, res, next) => {
  try {
    const enrollmentsCount = await prisma.enrollment.count({
      where: {
        course_id: parseInt(req.params.id),
        student_id: { not: null },
      },
    });

    if (enrollmentsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `لا يمكن حذف الكورس — يوجد ${enrollmentsCount} طالب مسجل فيه.`,
      });
    }

    await prisma.course.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true, message: "Course deleted." });
  } catch (err) { next(err); }
};

module.exports = { getCourses, createCourse, updateCourse, deleteCourse };