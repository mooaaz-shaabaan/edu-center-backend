// بيولّد HTML إيصال — الـ Flutter/Browser بيطبعه كـ PDF

const generateReceipt = (payment) => {
  const html = `
<!DOCTYPE html>
<html dir="auto" lang="ar">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 40px; max-width: 600px; margin: auto; }
    .header { text-align: center; margin-bottom: 20px; }
    .header h1 { font-size: 24px; }
    .header p { font-size: 14px; color: #555; }
    .divider { border: none; border-top: 1px solid #ccc; margin: 16px 0; }
    .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; flex-direction: row-reverse; }
    .row .label { font-weight: bold; color: #333; direction: rtl; text-align: right; }
    .row .value { color: #444; text-align: right; }
    .footer { text-align: center; font-size: 12px; color: #888; margin-top: 20px; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${payment.center_name || "Edu Center"}</h1>
    <p>إيصال دفع</p>
  </div>
  <hr class="divider">
  <div class="row"><span class="label">رقم الإيصال</span><span class="value">${payment.receipt_number}</span></div>
  <div class="row"><span class="label">الطالب</span><span class="value">${payment.student_name}</span></div>
  <div class="row"><span class="label">رقم الهاتف</span><span class="value">${payment.student_phone || "-"}</span></div>
  <div class="row"><span class="label">المبلغ</span><span class="value">${payment.amount} جنيه</span></div>
  <div class="row"><span class="label">التاريخ</span><span class="value">${new Date(payment.paid_at).toLocaleDateString("ar-EG")}</span></div>
  ${payment.notes ? `<div class="row"><span class="label">ملاحظات</span><span class="value">${payment.notes}</span></div>` : ""}
  <hr class="divider">
  <div class="footer">شكراً لثقتكم 🎓</div>
</body>
</html>`;

  return html;
};

module.exports = { generateReceipt };
