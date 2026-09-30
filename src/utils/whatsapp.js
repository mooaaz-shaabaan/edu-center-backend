// src/utils/whatsapp.js
const prisma = require("../config/db");

const buildMessage = (type, data) => {
  switch (type) {
    case "welcome":
      return `مرحباً بك في ${data.centerName} 🎓\n\nالطالب: ${data.studentName}\nكود البورتال: ${data.portalCode}\n\nيمكنك متابعة بيانات طفلك عبر الرابط:\n${data.portalUrl}`;
    case "installment_reminder":
      return `تذكير بموعد سداد القسط 💰\n\nالطالب: ${data.studentName}\nالمبلغ: ${data.amount} جنيه\nتاريخ الاستحقاق: ${data.dueDate}`;
    case "exam_notification":
      return `إشعار امتحان 📝\n\nالطالب: ${data.studentName}\nالمادة: ${data.courseName}\nعنوان الامتحان: ${data.examTitle}\nالتاريخ: ${data.examDate}\nالمكان: ${data.location || "سيتم الإعلان لاحقاً"}`;
    case "conflict_alert":
      return `⚠️ تنبيه تعارض في الجدول\n\nتم اكتشاف تعارض في جدول ${data.courseName}\nالأوضة: ${data.roomName}`;
    default:
      return data.message || "";
  }
};

const sendWhatsApp = async ({ phone, type, data, student_id = null }) => {
  try {
    const message = buildMessage(type, data);
    const formattedPhone = phone.startsWith("0") ? "2" + phone : phone;

    const apiUrl = process.env.WHATSAPP_API_URL;
    const apiKey = process.env.WHATSAPP_API_KEY;

    if (!apiUrl || !apiKey || apiKey === "your_whatsapp_api_key") {
      console.warn("⚠️ WhatsApp API not configured.");
      await logNotification({
        student_id,
        type,
        phone,
        message,
        status: "failed",
      });
      return { success: false, reason: "API not configured" };
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ phone: formattedPhone, message }),
    });

    const status = response.ok ? "sent" : "failed";
    await logNotification({ student_id, type, phone, message, status });
    return { success: response.ok, message };
  } catch (err) {
    console.error("❌ WhatsApp send error:", err.message);
    await logNotification({
      student_id,
      type,
      phone,
      message: buildMessage(type, data),
      status: "failed",
    });
    return { success: false, error: err.message };
  }
};

const logNotification = async ({
  student_id,
  type,
  phone,
  message,
  status,
}) => {
  try {
    await prisma.notificationLog.create({
      data: { student_id: student_id || null, type, phone, message, status },
    });
  } catch (err) {
    console.error("❌ Failed to log notification:", err.message);
  }
};

module.exports = { sendWhatsApp };
