// src/modules/drawers/drawers.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF, MANAGERS } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");
const withNotify = require("../../core/withNotify");

const {
  getDrawers,
  getDrawerState,
  getDrawerCounts,
  getDrawerLedger,
  createDrawer,
  updateDrawer,
  deleteDrawer,
  manualCount,
} = require("./drawers.controller");

const idField = z.coerce.number().int().positive();

/// المبلغ في الدرج — بيبدأ من صفر (درج فاضي حالة عادية)
const money = z.coerce.number().min(0).max(100000000);

const boolParam = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

const idParam = z.object({ params: z.object({ id: idField }) });

const listSchema = z.object({
  query: z.object({
    branch_id: idField.optional(),
    is_active: boolParam,
    tenant_id: idField.optional(),
  }),
});

const countsSchema = z.object({
  params: z.object({ id: idField }),
  query: z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    tenant_id: idField.optional(),
  }),
});

const createSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100),
    branch_id: idField,
    tenant_id: idField.optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
  }),
});

const ledgerSchema = z.object({
  params: z.object({ id: idField }),
  query: z.object({
    limit: z.coerce.number().int().positive().max(500).optional(),
    // "all" = من أول الدرج بدل من آخر جرد
    since: z.enum(["all"]).optional(),
    branch_id: idField.optional(),
    tenant_id: idField.optional(),
  }),
});

const countSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    counted: money,
    // الرقم اللي الشاشة عرضته — لو اتغيّر بيرجع 409 بالجديد
    expected_seen: money.optional(),
    note: z.string().max(300).optional(),
    tenant_id: idField.optional(),
  }),
});

router.use(auth);

// أي موظف محتاج يقرا حالة الدرج عشان يفتح وردية عليه
router.get("/", validate(listSchema), requireRole(...STAFF), getDrawers);

router.get(
  "/:id/state",
  validate(idParam),
  requireRole(...STAFF),
  getDrawerState,
);

// كشف حركة الدرج — كل حاجة دخلت أو خرجت ومين عملها.
// مفتوح لأي موظف: هو مسؤول عن الصندوق اللي قدامه، فلازم يشوف
// اللي حصل فيه.
router.get(
  "/:id/ledger",
  validate(ledgerSchema),
  requireRole(...STAFF),
  getDrawerLedger,
);

// سجل الجرد (مين عدّ وكام العجز) — للمديرين بس
router.get(
  "/:id/counts",
  validate(countsSchema),
  requireRole(...MANAGERS),
  getDrawerCounts,
);

// إدارة الدروج — الأونر وأدمن الفرع
router.post(
  "/",
  validate(createSchema),
  requireRole(...MANAGERS),
  withNotify(createDrawer, "drawers_updated"),
);

router.put(
  "/:id",
  validate(updateSchema),
  requireRole(...MANAGERS),
  withNotify(updateDrawer, "drawers_updated"),
);

router.delete(
  "/:id",
  validate(idParam),
  requireRole(...MANAGERS),
  withNotify(deleteDrawer, "drawers_updated"),
);

// جرد يدوي — بيخلي أي حد شغال على الدرج يأكد الرصيد الجديد
router.post(
  "/:id/count",
  validate(countSchema),
  requireRole(...MANAGERS),
  withNotify(manualCount, ["drawers_updated", "shifts_updated"]),
);

module.exports = router;
