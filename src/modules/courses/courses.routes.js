const express = require("express");
const router = express.Router();
const auth = require("../../middlewares/auth");
const role = require("../../middlewares/role");
const { getCourses, createCourse, updateCourse, deleteCourse } = require("./courses.controller");

router.use(auth);

router.get("/",         getCourses);
router.post("/",        role("admin"), createCourse);
router.put("/:id",      role("admin"), updateCourse);
router.delete("/:id",   role("admin"), deleteCourse);

module.exports = router;