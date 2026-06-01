// src/utils/qrGenerator.js
const QRCode = require("qrcode");

const generateQRCode = async (data) => {
  try {
    // بيولّد QR Code كـ Base64 PNG
    const qrBase64 = await QRCode.toDataURL(String(data), {
      width: 300,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });
    return qrBase64;
  } catch (err) {
    console.error("QR generation failed:", err);
    return null;
  }
};

module.exports = { generateQRCode };
