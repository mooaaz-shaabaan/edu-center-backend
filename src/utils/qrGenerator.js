// src/utils/qrGenerator.js
const QRCode = require("qrcode");
const { PNG } = require("pngjs");

// ألوان الهوية — نفس أرقام AppColors في الفلاتر بالظبط
const PRIMARY = [0x4f, 0x46, 0xe5];
const PRIMARY_DARK = [0x37, 0x30, 0xa3];
const WHITE = [0xff, 0xff, 0xff];

// العلامة بتاخد نسبة من **عرض الكود نفسه**، مش من عرض الصورة.
//
// ⚠ الفرق ده هو الفرق بين كود بيتقري وكود مابيتقريش.
//
//   أول نسخة كانت ٢٤٪ من عرض الصورة. ده ظبط مع رابط التسجيل
//   (٤١ مربّع) وفشل تمامًا مع كود الطالب (٢١ مربّع): نفس
//   النسبة من البكسلات = ضِعف عدد المربّعات المغطّاة، والعلامة
//   وصلت لخطوط التوقيت (الصف والعمود رقم ٦) — ودي مش بيانات
//   يتعوّض عنها بالـ ECC، دي اللي القارئ بيعرف منها مقاس
//   المربّع أصلاً. يعني الكود مابيتلقطش من أوله.
//
//   النسبة من الكود بتخلّي عدد المربّعات المغطّاة ثابت مهما
//   طال النص. والرقم اتحدّد بالقياس مش بالذوق — شوف
//   `LOGO_RATIO` في `lib/shared/utils/qr_saver.dart`، لازم
//   يفضلوا متطابقين.
const LOGO_RATIO = 0.2;

// الهامش الأبيض حوالين العلامة، كنسبة من ضلعها
const LOGO_PAD = 0.11;

// ══ شكل الكود ══════════════════════════════════════
//
// ⚠ بنرسم الكود بإيدنا من مصفوفة المربّعات، مستعملينش
//   الراسم بتاع المكتبة. هي بترسم مربّعات سودا صماء وخلاص،
//   واحنا عايزين تدرّج وزوايا مدوّرة وعيون بشكل خاص.

// —— أرقام الشكل (بالمربّعات) ——
//
// ⚠ كل رقم فيهم اتحدد بالقياس على قارئ QR حقيقي،
//   مش بالذوق. التدوير مش زينة مجّانية — بيشيل من مساحة
//   الأسود، والقارئ بيبني شبكته من العيون وخطوط التوقيت.
//
//   القياس (١٠٨ حالة كاميرا لكل رقم، على كود طالب ورابط):
//
//     تدوير المربّع:  ٠ ← ٩٨/٨٨  ·  ٠٫٥ ← ١٠٠/٨٧
//         مجّاني تماماً لأن المتجاورين بيلحموا، فمركز كل
//         مربّع بيفضل مصمت. فبناخد أقصى قيمة.
//
//     إطار العين:    ٠٫٤ ← ١٠٤/٨٧  ·  ٠٫٧ ← ٩٩/٧٠  ·  ١٫٢ ← ٦١/٣٨
//         أغلى حاجة في الشكل. القارئ بيدوّر على نسبة
//         ١:١:٣:١:١ في خطوط ماشية في العين — والتدوير بيبوظ
//         النسبة دي في الخطوط البعيدة عن المركز.
//         (المرجع اللي اتبعت كان عيونه مدوّرة أوي — شكله حلو
//          بس جرّبناه والقراءة وقعت لـ ١٣/١٠٨.)
//
//     البؤبؤ:        ٠ ← ١٠٠  ·  ٠٫٩ ← ١٠٤  ·  ١٫٥ (دايرة) ← ٧٢
//         لحد ٠٫٩ بيحسّن فعلاً، والدايرة الكاملة بتوقّع.
const MODULE_RADIUS = 0.5;
const EYE_OUTER_RADIUS = 0.4;
const EYE_INNER_RADIUS = 0.6;
const EYE_PUPIL_RADIUS = 0.9;

/**
 * هل النقطة جوه مستطيل كل ركن فيه بنصف قطره؟
 *
 * ⚠ الأركان منفصلة عشان المربّعات المتجاورة تلحم في
 *   بعض. لو دوّرنا الأربعة دايماً، سطر من خمس مربّعات
 *   يطلع خمس حبات منفصلة ومساحة الأسود تقل كتير —
 *   وده بيضرب القراءة. بندوّر الركن بس لما يكون فعلاً
 *   ركن خارجي (مافيش جار في الاتجاهين).
 */
function inCorneredRect(x, y, w, h, tl, tr, bl, br) {
  if (x < 0 || y < 0 || x > w || y > h) return false;

  if (tl > 0 && x < tl && y < tl) {
    return (x - tl) ** 2 + (y - tl) ** 2 <= tl * tl;
  }
  if (tr > 0 && x > w - tr && y < tr) {
    return (x - (w - tr)) ** 2 + (y - tr) ** 2 <= tr * tr;
  }
  if (bl > 0 && x < bl && y > h - bl) {
    return (x - bl) ** 2 + (y - (h - bl)) ** 2 <= bl * bl;
  }
  if (br > 0 && x > w - br && y > h - br) {
    return (x - (w - br)) ** 2 + (y - (h - br)) ** 2 <= br * br;
  }
  return true;
}

/** هل النقطة جوه مستطيل بأركان مدوّرة؟ (الإحداثيات بالنسبة لركنه) */
function inRoundRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
];

/**
 * لون نقطة واحدة جوه مربّع العلامة.
 *
 * ⚠ الهندسة دي منقولة حرف بحرف من `AppLogoPainter` في
 *   `lib/shared/widgets/app_logo.dart` — نفس الوحدة (١٪ من
 *   الضلع) ونفس الأرقام: مدار ٢٩، سُمكه ٧، فروع ٩٫٥، مركز ١٢.
 *   أي تعديل في واحد لازم يتعمل في التاني، وإلا العلامة اللي
 *   في البرنامج هتبقى غير اللي على الورق.
 */
function markColor(x, y, s) {
  // بره المربّع المدوّر = الهامش الأبيض اللي بيفصل العلامة
  // عن مربّعات الكود
  if (!inRoundRect(x, y, s, s, s * 0.22)) return WHITE;

  // التدرّج من فوق-يمين لتحت-شمال زي الفلاتر
  const base = mix(PRIMARY, PRIMARY_DARK, Math.min(1, (x + y) / (2 * s)));

  const u = s / 100;
  const cx = 50 * u;
  const cy = 50 * u;
  const orbit = 29 * u;

  const dist = Math.hypot(x - cx, y - cy);

  // المركز
  if (dist <= 12 * u) return WHITE;

  // تلات فروع على المدار
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    const bx = cx + orbit * Math.cos(a);
    const by = cy + orbit * Math.sin(a);
    if (Math.hypot(x - bx, y - by) <= 9.5 * u) return WHITE;
  }

  // المدار نفسه — باهت عشان الفروع والمركز هما اللي يبانوا
  if (Math.abs(dist - orbit) <= 3.5 * u) return mix(base, WHITE, 0.45);

  return base;
}

/**
 * بيطبع العلامة في نص صورة الـ QR (بيعدّل الـ png في مكانه).
 *
 * ⚠ بنرسم بـ ٤×٤ عيّنات لكل بكسل وبناخد المتوسط. من غير كده
 *   حواف الدواير بتطلع مسنّنة — والعلامة في ٦٠ بكسل حوافها
 *   هي اللي بتفرّق بين شكل محترم وشكل مهبّب.
 */
function stampMark(png, modules, ratio = LOGO_RATIO) {
  const W = png.width;
  const H = png.height;

  // عرض الكود من غير الهامش: الصورة فيها هامش مربّعين كل ناحية
  const codeWidth = (Math.min(W, H) * modules) / (modules + 4);

  const tile = Math.max(12, Math.round(codeWidth * ratio));
  const pad = Math.max(2, Math.round(tile * LOGO_PAD));
  const outer = tile + pad * 2;
  const outerR = outer * 0.28;

  const ox = Math.round((W - outer) / 2);
  const oy = Math.round((H - outer) / 2);

  const SS = 4;
  const samples = SS * SS;

  for (let py = 0; py < outer; py++) {
    const gy = oy + py;
    if (gy < 0 || gy >= H) continue;

    for (let px = 0; px < outer; px++) {
      const gx = ox + px;
      if (gx < 0 || gx >= W) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!inRoundRect(x, y, outer, outer, outerR)) continue;

          const c = markColor(x - pad, y - pad, tile);
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }

      if (hits === 0) continue;

      // نسبة التغطية = شفافية الحافة؛ الباقي بيفضل مربّعات الكود
      const a = hits / samples;
      const i = (gy * W + gx) << 2;
      png.data[i] = Math.round(png.data[i] * (1 - a) + (r / hits) * a);
      png.data[i + 1] = Math.round(png.data[i + 1] * (1 - a) + (g / hits) * a);
      png.data[i + 2] = Math.round(png.data[i + 2] * (1 - a) + (b / hits) * a);
      png.data[i + 3] = 255;
    }
  }
}

/**
 * بيرسم مصفوفة الـ QR بهوية النظام.
 *
 * الفرق عن راسم المكتبة:
 *   • المربّعات بزوايا مدوّرة، والمتجاور منهم بيلحم
 *   • تدرّج من `primary` لـ `primaryDark` — نفس اتجاه تدرّج اللوجو
 *   • العيون التلاتة بإطار مدوّر غامق وبؤبؤ أفتح
 *
 * ⚠ الشكل مش زينة مجّانية — كل تدويرة بتشيل من مساحة
 *   الأسود، والقارئ بيقرّر المربّع غامق ولا فاتح من متوسط
 *   لون مركزه. عشان كده بنلحم المتجاورين بدل ما نسيبهم
 *   حبات منفصلة: سطر ملحوم بيحافظ على مركز كل مربّع
 *   مصمت، والتدوير بيبان على الأطراف الخارجية بس.
 */
function renderMatrix(modules, scale, margin, style = {}) {
  const {
    moduleRadius = MODULE_RADIUS,
    eyeOuter = EYE_OUTER_RADIUS,
    eyeInner = EYE_INNER_RADIUS,
    eyePupil = EYE_PUPIL_RADIUS,
    ss = 1,
  } = style;
  const n = modules.size;
  const side = (n + margin * 2) * scale;

  const png = new PNG({ width: side, height: side });
  const buf = png.data;

  // خلفية بيضا
  buf.fill(0xff);

  const off = margin * scale;

  // العيون التلاتة (٧×٧ في كل ركن ماعدا تحت-يمين)
  const eyes = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
  const inEye = (r, c) =>
    eyes.some(([er, ec]) => r >= er && r < er + 7 && c >= ec && c < ec + 7);

  const isData = (r, c) =>
    r >= 0 && c >= 0 && r < n && c < n && modules.get(r, c) && !inEye(r, c);

  // لون التدرّج — من فوق-يمين لتحت-شمال زي اللوجو.
  //
  // ⚠ اللون بيتحسب **لكل مربّع**، مش لكل بكسل.
  //
  //   أول نسخة كانت بتحسبه لكل بكسل، فطلعت الصورة ١٣٠
  //   ألف لون مختلف والـ PNG مالقاش حاجة يضغطها:
  //   ١٣ كيلو بقوا ٤٣. والصورة دي بتتبعت في رد كل مرة
  //   الموظف يفتح فيها شيت طالب.
  //
  //   المربّع الواحد بلون مسطّح بيضغط زي الأسود الصمت،
  //   والتدرّج لسه باين لأن فيه ٣٠-٤٠ درجة عرض الكود.
  const shadeAt = (row, col) =>
    mix(
      PRIMARY,
      PRIMARY_DARK,
      Math.min(1, (row + col + 1) / (2 * (n + 1)))
    );

  const put = (x, y, color, a) => {
    const i = (y * side + x) << 2;
    buf[i] = Math.round(buf[i] * (1 - a) + color[0] * a);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + color[1] * a);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + color[2] * a);
    buf[i + 3] = 255;
  };

  // —— نعومة الحواف: عيّنة واحدة لكل بكسل
  //
  // ⚠ مش كسل — ده قرار حجم. النعومة بتولّد ألوان
  //   وسيطة على كل حافة، والـ PNG مابيعرفش يضغطها:
  //     عيّنة ٣×٣ ← ٣٤ و ٥٧ كيلو
  //     عيّنة ١×١ ← ٢٢ و ٣٣ كيلو
  //
  //   والفرق البصري؟ قارنّاهم بتكبير ٣× ومابانش فرق
  //   يذكر — والكود أصلاً بيتعرض في ١١٨ بكسل في البوابة
  //   يعني بيتصغّر والتصغير بينعّمه لوحده.
  //
  //   النسخة اللي البرنامج بيحفظها للطباعة بتترسم على
  //   الـ Canvas بنعومة كاملة — وده المكان الوحيد اللي
  //   بيتعرض فيه الكود كبير فعلاً.
  //
  //   (العلامة في النص لسه بتترسم بـ ٤×٤ — مساحة صغيرة
  //    ودواير دقيقة، فالنعومة هناك رخيصة وواجبة.)
  const SS = ss;
  const SAMPLES = SS * SS;

  // —— وحدات البيانات
  const r0 = scale * moduleRadius;

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!isData(row, col)) continue;

      const up = isData(row - 1, col);
      const down = isData(row + 1, col);
      const left = isData(row, col - 1);
      const right = isData(row, col + 1);

      const tl = !up && !left ? r0 : 0;
      const tr = !up && !right ? r0 : 0;
      const bl = !down && !left ? r0 : 0;
      const br = !down && !right ? r0 : 0;

      const x0 = off + col * scale;
      const y0 = off + row * scale;

      // جوّه الكتلة خالص؟ املاه على طول — مفيش حاجة تتنعّم
      const plain = tl === 0 && tr === 0 && bl === 0 && br === 0;
      const tone = shadeAt(row, col);

      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const gx = x0 + px;
          const gy = y0 + py;

          if (plain) {
            put(gx, gy, tone, 1);
            continue;
          }

          let hits = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const lx = px + (sx + 0.5) / SS;
              const ly = py + (sy + 0.5) / SS;
              if (inCorneredRect(lx, ly, scale, scale, tl, tr, bl, br)) hits++;
            }
          }
          if (hits) put(gx, gy, tone, hits / SAMPLES);
        }
      }
    }
  }

  // —— العيون
  //
  // ⚠ المقاسات ثابتة بالمواصفة: إطار ٧×٧ سُمكه مربّع
  //   واحد، فاضي ١ مربّع، بؤبؤ ٣×٣. اللي بنغيّره هو التدوير
  //   واللون بس — أي لمس في المقاسات بيخلي القارئ مايلاقيش
  //   الكود أصلاً.
  for (const [er, ec] of eyes) {
    const x0 = off + ec * scale;
    const y0 = off + er * scale;
    const box = 7 * scale;

    const pupilTone = shadeAt(er + 3, ec + 3);
    const outerR = eyeOuter * scale;
    const innerR = eyeInner * scale;
    const pupilR = eyePupil * scale;

    for (let py = 0; py < box; py++) {
      for (let px = 0; px < box; px++) {
        let frame = 0;
        let pupil = 0;

        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const lx = px + (sx + 0.5) / SS;
            const ly = py + (sy + 0.5) / SS;

            // الإطار = المربّع الخارجي ناقص الداخلي
            const outside =
              lx < 0 || ly < 0 || lx > box || ly > box
                ? false
                : inRoundRect(lx, ly, box, box, outerR);
            const hollow = inRoundRect(
              lx - scale,
              ly - scale,
              box - 2 * scale,
              box - 2 * scale,
              innerR
            );
            if (outside && !hollow) frame++;

            if (
              inRoundRect(
                lx - 2 * scale,
                ly - 2 * scale,
                box - 4 * scale,
                box - 4 * scale,
                pupilR
              )
            ) {
              pupil++;
            }
          }
        }

        const gx = x0 + px;
        const gy = y0 + py;
        if (frame) put(gx, gy, PRIMARY_DARK, frame / SAMPLES);
        if (pupil) put(gx, gy, pupilTone, pupil / SAMPLES);
      }
    }
  }

  return png;
}

/**
 * أقوى مستوى تصحيح من غير ما الكود يكبر **أكتر من نسخة واحدة**.
 *
 * ⚠ ده أهم سطر في الملف. الغريزة بتقول «حطّ H على طول عشان
 *   العلامة»، وده غلط: H بياخد مساحة أكتر للتصحيح، ولما
 *   المساحة ماتكفّيش بيقفز لنسخة أكبر — رابط التسجيل عندنا
 *   بيقفز من ٣٣ مربّع لـ ٤١. والمربّعات الأصغر بتضيع من
 *   الكاميرا قبل ما التصحيح الزيادة يلحق ينفع.
 *
 *   قِسنا التلاتة على نفس الرابط (١٠٨ حالة كاميرا + ٢٠ خربشة):
 *     M (٣٣ مربّع) ← ٩٢ و ١٢
 *     Q (٣٣ مربّع) ← ٩٥ و ١٦   ← الأحسن في الاتنين
 *     H (٤١ مربّع) ← ٨٥ و ١٥
 *   وعلى كود الطالب القصير التلاتة ٢١ مربّع، فـ H بيبقى ببلاش
 *   (١٠٦ و ١٧).
 *
 *   يعني القاعدة مش «مستوى ثابت». بس «نفس عدد المربّعات
 *   بالظبط» طلعت صارمة زيادة: الروابط الحقيقية بتخلّي Q و H
 *   الاتنين يكبّروا، فكنا بنقع على M — و M مع لوجو معناها
 *   ١٥٪ تصحيح ناقص منها ٦٪ للعلامة، هامش رفيع على ورق مطبوع.
 *
 *   فالسقف بقى **نسخة واحدة** (٤ مربّعات). على رابط حقيقي:
 *     M (٣٣) ← ٧٧ و ١٥
 *     Q (٣٧) ← ٩٠ و ٢٧   ← الأحسن
 *     H (٤١) ← ٨٨ و ٢٧
 */
function pickLevel(text) {
  const sizeAt = (level) =>
    QRCode.create(text, { errorCorrectionLevel: level }).modules.size;

  const base = sizeAt("M");

  // نسخة واحدة أكبر = ٤ مربّعات زيادة. ده السقف.
  for (const level of ["H", "Q"]) {
    if (sizeAt(level) <= base + 4) return level;
  }
  return "M";
}

/**
 * QR بالعلامة في نصّه، Base64 PNG جاهز لـ `<img src>`.
 *
 * @param {*} data النص اللي جوه الكود
 * @param {{width?: number, logo?: boolean, level?: string,
 *          logoRatio?: number}} [options]
 */
const generateQRCode = async (data, options = {}) => {
  const { logoRatio = LOGO_RATIO } = options;
  // ⚠ ٤٨٠ مش ٣٠٠ — عرض مطلوب، بنقرّبه تحت لأقرب مضاعف.
  //
  //   قِسنا الفرق على ١٠٨ حالة (مقاسات × ضبابية × ضوضا × ميل):
  //   ٣٠٠ ← ٨٥ ، ٣٦٠ ← ٩٣ ، ٤٨٠ ← ٩٨ ، ٦٤٠ ← ٩٩.
  //   يعني بعد ٤٨٠ المكسب بيقف والحجم بس هو اللي بيزيد.
  const { width = 480, logo = true } = options;

  const text = String(data);

  try {
    // ⚠ جوه الـ try: `pickLevel` بينده `QRCode.create` اللي
    //   بيرمي على النص الفاضي. الدالة دي عقدها إنها ترجّع
    //   `null` لو حصل أي حاجة — مش تطيّر الريكوست كله.
    const level = options.level || (logo ? pickLevel(text) : "M");

    const { modules } = QRCode.create(text, { errorCorrectionLevel: level });

    // —— مقاس المربّع لازم يبقى عدد صحيح من البكسلات
    //
    // ⚠ ده مش تحسين — ده فرق بين كود بيتقري وكود لأ.
    //
    //   لما بنطلب عرض مش مضاعف لعدد المربّعات، المكتبة
    //   بتقسّم الكسر على المربّعات — فيطلع مربّع بـ١٣ بكسل
    //   واللي جنبه بـ١٢. القارئ بيقيس الشبكة من خطوط
    //   التوقيت وبيسقط على المربّعات الغلط.
    //
    //   اكتشفناه بالصدفة: نفس الرابط بعرض ٤٨٠ مابيتقريش
    //   وهو نضيف خالص، وبـ٤٨١ بيتقري. والنسخة القديمة
    //   (٣٠٠ من غير لوجو) كان عندها نفس المشكلة مستخبية —
    //   كانت شغّالة بالحظ مع النصوص اللي جرّبناها.
    const span = modules.size + 4; // + هامش مربّعين كل ناحية
    const scale = Math.max(1, Math.round(width / span));

    const png = renderMatrix(modules, scale, 2, options.style);
    if (logo) stampMark(png, modules.size, logoRatio);

    return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
  } catch (err) {
    console.error("QR generation failed:", err);
    return null;
  }
};

module.exports = { generateQRCode };
