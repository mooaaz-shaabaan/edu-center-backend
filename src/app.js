// src/app.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const errorHandler = require("./middlewares/errorHandler");
const coursesRoutes = require("./modules/courses/courses.routes");



const app = express();

app.use(cors({
  origin: '*', // ← اسمح لأي origin
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: process.env.APP_NAME || "Edu Center",
    timestamp: new Date().toISOString(),
  });
});

// قبل الـ Routes
app.use(express.static(path.join(__dirname, '../public')));

// ── Routes ───────────────────────────────────────────────
app.use("/api/portal",     require("./modules/portal/portal.routes"));
app.use("/api/auth",       require("./modules/auth/auth.routes"));
app.use("/api/students",   require("./modules/students/students.routes"));
app.use("/api/shifts",     require("./modules/shifts/shifts.routes"));
app.use("/api/attendance", require("./modules/attendance/attendance.routes"));
app.use("/api/schedules",  require("./modules/schedules/schedules.routes"));
app.use("/api",            require("./modules/branches/branches.routes"));
app.use("/api/payments",   require("./modules/payments/payments.routes"));
app.use("/api/reports",    require("./modules/reports/reports.routes"));
app.use("/api/search",     require("./modules/search/search.routes"));
app.use("/api",            require("./modules/semesters/semesters.routes"));
app.use("/api/users",      require("./modules/users/users.routes"));
app.use("/api/courses",   coursesRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use(errorHandler);

module.exports = app;