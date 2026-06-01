// src/modules/branches/branches.controller.js
const prisma = require("../../config/db");

// ═══════════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════════

const getBranches = async (req, res, next) => {
  try {
    const branches = await prisma.branch.findMany({
      where: { is_active: true },
      orderBy: { created_at: "asc" },
    });
    res.json({ success: true, data: branches });
  } catch (err) { next(err); }
};

const createBranch = async (req, res, next) => {
  try {
    const { name, address, phone } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "name is required." });

    const branch = await prisma.branch.create({ data: { name, address, phone } });
    res.status(201).json({ success: true, message: "Branch created.", data: branch });
  } catch (err) { next(err); }
};

const updateBranch = async (req, res, next) => {
  try {
    const { name, address, phone, is_active } = req.body;
    const branch = await prisma.branch.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(name && { name }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(is_active !== undefined && { is_active }),
      },
    });
    res.json({ success: true, message: "Branch updated.", data: branch });
  } catch (err) { next(err); }
};

const getBranchStats = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);

    const [students, payments, attendance] = await Promise.all([
      prisma.student.count({ where: { branch_id: id, is_active: true } }),
      prisma.payment.aggregate({
        where: { student: { branch_id: id } },
        _sum: { amount: true },
      }),
      prisma.attendance.count({
        where: { student: { branch_id: id }, status: "present" },
      }),
    ]);

    res.json({
      success: true,
      data: {
        branch_id: id,
        total_students: students,
        total_revenue: payments._sum.amount || 0,
        total_attendance: attendance,
      },
    });
  } catch (err) { next(err); }
};


// ═══════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════

const getRooms = async (req, res, next) => {
  try {
    const { branch_id } = req.query;
    const where = {};
    if (branch_id) where.branch_id = parseInt(branch_id);

    const rooms = await prisma.room.findMany({
      where,
      orderBy: { created_at: "asc" },
      include: { branch: { select: { id: true, name: true } } },
    });
    res.json({ success: true, data: rooms });
  } catch (err) { next(err); }
};

const createRoom = async (req, res, next) => {
  try {
    const { name, capacity, branch_id } = req.body;
    if (!name || !branch_id) {
      return res.status(400).json({ success: false, message: "name and branch_id are required." });
    }

    const room = await prisma.room.create({
      data: {
        name,
        capacity: capacity ? parseInt(capacity) : null,
        branch_id: parseInt(branch_id),
      },
      include: { branch: { select: { id: true, name: true } } },
    });
    res.status(201).json({ success: true, message: "Room created.", data: room });
  } catch (err) { next(err); }
};

const updateRoom = async (req, res, next) => {
  try {
    const { name, capacity } = req.body;
    const room = await prisma.room.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(name && { name }),
        ...(capacity !== undefined && { capacity: parseInt(capacity) }),
      },
    });
    res.json({ success: true, message: "Room updated.", data: room });
  } catch (err) { next(err); }
};

module.exports = {
  getBranches, createBranch, updateBranch, getBranchStats,
  getRooms, createRoom, updateRoom,
};
