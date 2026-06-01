// src/utils/phoneValidator.js
// بيتحقق من تنسيق الأرقام المصرية (010/011/012/015 — 11 رقم)

const validateEgyptianPhone = (phone) => {
  const regex = /^(010|011|012|015)\d{8}$/;
  return regex.test(phone);
};

module.exports = { validateEgyptianPhone };
