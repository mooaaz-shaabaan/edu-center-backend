// src/modules/schedules/schedules.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getAll,
  create,
  update,
  remove,
  getConflicts,
} = require("./schedules.controller");

const idField = z.coerce.number().int().positive();
const timeStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM.");

const listSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    course_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const createSchema = z.object({
  body: z.object({
    course_id: idField,
    room_id: idField,
    day_of_week: z.coerce.number().int().min(0).max(6),
    start_time: timeStr,
    end_time: timeStr,
    teacher: z.string().max(150).nullable().optional(),
    tenant_id: idField.optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    course_id: idField.optional(),
    room_id: idField.optional(),
    day_of_week: z.coerce.number().int().min(0).max(6).optional(),
    start_time: timeStr.optional(),
    end_time: timeStr.optional(),
    teacher: z.string().max(150).nullable().optional(),
  }),
});

const idParam = z.object({ params: z.object({ id: idField }) });

router.use(auth);

router.get("/", validate(listSchema), requireRole(...STAFF), getAll);

router.get("/conflicts", requireRole("admin", "super_admin"), getConflicts);

router.post(
  "/",
  validate(createSchema),
  requireRole("admin", "super_admin"),
  withNotify(create, "schedules_updated"),
);

router.put(
  "/:id",
  validate(updateSchema),
  requireRole("admin", "super_admin"),
  withNotify(update, "schedules_updated"),
);

router.delete(
  "/:id",
  validate(idParam),
  requireRole("admin", "super_admin"),
  withNotify(remove, "schedules_updated"),
);

module.exports = router;
