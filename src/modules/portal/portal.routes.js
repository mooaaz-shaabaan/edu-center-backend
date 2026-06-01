// src/modules/portal/portal.routes.js
const express = require("express");
const router = express.Router();
const prisma = require("../../config/db");

// GET /api/portal/:studentCode
router.get("/:studentCode", async (req, res, next) => {
  try {
    const student = await prisma.student.findUnique({
    where: { portal_code: req.params.studentCode },
    select: {
        id: true,
        name: true,
        portal_code: true,
        photo: true,
        enrollments: {
            include: { course: { select: { id: true, name: true } } },
        },
        attendance: {
            orderBy: { date: "desc" },
            take: 10,
            select: { 
              date: true, 
              status: true,
              course: { select: { name: true } }, // ← أضف
            },
        },
        grades: {                           // ← أضف
            include: {
               exam: { select: { title: true, exam_date: true } },
            },
        orderBy: { created_at: "desc" },
        },
    },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: "الكود غير صحيح." });
    }

    res.json({ success: true, data: student });
  } catch (err) { next(err); }
});

// POST /api/portal/:studentCode/photo
router.post("/:studentCode/photo", async (req, res, next) => {
  try {
    const student = await prisma.student.findUnique({
      where: { portal_code: req.params.studentCode },
      select: { id: true, photo: true },
    });

    if (!student) {
      return res.status(404).json({ success: false, message: "الكود غير صحيح." });
    }

    if (student.photo) {
      return res.status(400).json({
        success: false,
        message: "تم رفع الصورة مسبقاً — مش مسموح بالتغيير.",
      });
    }

    const { photo } = req.body;
    if (!photo) return res.status(400).json({ success: false, message: "photo is required." });
    if (!photo.startsWith("data:image/")) return res.status(400).json({ success: false, message: "صيغة الصورة غير صحيحة." });

    await prisma.student.update({
      where: { id: student.id },
      data: { photo },
    });

    res.json({ success: true, message: "تم رفع الصورة بنجاح." });
  } catch (err) { next(err); }
});

module.exports = router;


