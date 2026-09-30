// src/modules/session/session.routes.js
// ⚠️ متركّب في app.js قبل الـ rate limiter — النبضة كل دقيقة ما تاكلش من الحد
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const validate = require("../../middlewares/validate");
const { heartbeat, endMySession, forceLogout } =
  require("./session.controller");

const idField = z.coerce.number().int().positive();

// user_id → الموظف نفسه، أو shift_id → صاحب الشيفت ده (من شاشة الشيفتات)
const forceSchema = z.object({
  body: z
    .object({
      user_id: idField.optional(),
      shift_id: idField.optional(),
      tenant_id: idField.optional(), // الـ interceptor بيحقنه
    })
    .refine((b) => b.user_id || b.shift_id, {
      message: "user_id or shift_id is required",
    }),
});

router.use(auth);

// نبضة كل دقيقة وهو فاتح البرنامج
router.post("/heartbeat", heartbeat);

// قفل البرنامج من X / آخر خطوة في تسجيل الخروج
router.post("/end", endMySession);

// خروج إجباري من المدير أو الأونر
router.post("/force-logout", validate(forceSchema), forceLogout);

module.exports = router;
