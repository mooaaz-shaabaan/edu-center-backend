// src/modules/app_release/app_release.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");

const auth = require("../../middlewares/auth");
const { requireRole, STAFF } = require("../../middlewares/rbac");
const validate = require("../../middlewares/validate");

const { getRelease, setRelease } = require("./app_release.controller");

const publishSchema = z.object({
  body: z.object({
    version: z
      .string()
      .trim()
      .min(1)
      .max(20)
      // ⚠ شكل ثابت عشان المقارنة في البرنامج تبقى مفهومة:
      //   «1.2.0» أو «1.2» — مش «نسخة أكتوبر»
      .regex(/^\d+(\.\d+){1,2}$/, "النسخة لازم تكون زي 1.2.0"),
    download_url: z
      .string()
      .trim()
      .url("اللينك مش مظبوط")
      .max(500)
      // ⚠ https بس: اللينك ده بيتفتح على أجهزة السناتر
      .refine((u) => u.startsWith("https://"), "اللينك لازم يبدأ بـhttps"),
    notes: z.string().trim().max(1000).optional().nullable(),
    is_mandatory: z.boolean().optional(),
  }),
});

router.use(auth);

// أي موظف داخل — البرنامج بيسأل عند الفتح
router.get("/", requireRole(...STAFF), getRelease);

// ⚠ مالك النظام بس. ده بيوصل لكل السناتر مرة واحدة، فمفيش
//   أونر سنتر يقدر ينشر حاجة لحد تاني.
router.put("/", requireRole("super_admin"), validate(publishSchema), setRelease);

module.exports = router;
