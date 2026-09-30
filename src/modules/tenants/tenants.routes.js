// src/modules/tenants/tenants.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");

const {
  getTenants,
  createTenant,
  updateTenant,
} = require("./tenants.controller");

const idField = z.coerce.number().int().positive();

// باسورد قوي (زي اللي في users)
const strongPassword = z
  .string()
  .min(8, "الباسورد لازم ٨ حروف على الأقل.")
  .max(128)
  .regex(/[a-zA-Z]/, "الباسورد لازم يكون فيه حرف.")
  .regex(/[0-9]/, "الباسورد لازم يكون فيه رقم.");

const createSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(150),
    // الـ slug: حروف صغيرة وأرقام وشرطة بس — بيدخل في الروابط
    slug: z
      .string()
      .trim()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9-]+$/, "الـ slug: حروف إنجليزية صغيرة وأرقام وشرطات بس."),
    email_domain: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(
        /^[a-z0-9.-]+\.[a-z]{2,}$/i,
        "الدومين شكله مش صح. مثال: alnour.com",
      ),

    // ⚠ كانت admin_* — الحساب اللي بيتعمل هنا هو **صاحب السنتر**
    //   مش أدمن. الأدمن بياخد فروعه بالتوزيع من الأونر.
    owner_name: z.string().trim().min(1).max(150),
    owner_email: z
      .string()
      .trim()
      .toLowerCase()
      .email("إيميل صاحب السنتر مش صحيح.")
      .max(255),
    owner_password: strongPassword,

    branch_name: z.string().trim().min(1).max(150).optional(),
    branch_address: z.string().trim().max(300).nullable().optional(),
    branch_phone: z.string().trim().max(20).nullable().optional(),

    // ⚠ الـ interceptor في الفلاتر بيحقن دول في كل body.
    //   من غير ما يبقوا معرّفين هنا، الطلب ممكن يترفض.
    tenant_id: idField.optional(),
    branch_id: idField.optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: idField }),
  body: z.object({
    name: z.string().trim().min(1).max(150).optional(),
    is_active: z.boolean().optional(),
    tenant_id: idField.optional(),
    branch_id: idField.optional(),
  }),
});

// ── كل المسارات: super_admin بس ───────────────────────────
router.use(auth);
router.use(requireRole("super_admin"));

router.get("/", getTenants);
router.post("/", validate(createSchema), createTenant);
router.put("/:id", validate(updateSchema), updateTenant);

module.exports = router;
