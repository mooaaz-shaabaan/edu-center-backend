# رفع الباك إند على الإنترنت (مجاني)

الهدف: السيرفر يبقى على لينك عام، فالـQR وصفحات الطلاب تشتغل من
أي موبايل في أي مكان — مش من شبكة المركز بس.

**التكلفة: صفر.** مفيش كارت ولا دومين في الخطوات دي.

```
Neon   →  الداتابيز (Postgres مجاني وبيفضل)
Render →  السيرفر   (Node مجاني)
```

> ⚠ **ليه مش داتابيز Render؟** المجانية بتاعتهم بتتمسح بعد شهر.
> Neon بتفضل.

---

## ١) الداتابيز على Neon — ٣ دقايق

1. ادخل [neon.tech](https://neon.tech) → سجّل بجوجل
2. **Create project** → الاسم `markazi` → المنطقة **Europe (Frankfurt)**
3. هيطلّعلك **Connection string**. خد النسخة **Direct** (اللي
   **مافيهاش** كلمة `-pooler`) واحفظها.

   > ⚠ الـ Pooled بتعمل مشاكل مع `prisma migrate`. وإحنا مش
   > محتاجينها أصلاً في الحجم ده.

   شكلها:
   ```
   postgresql://neondb_owner:xxxx@ep-aaa-bbb.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```

---

## ٢) ارفع الكود على GitHub

لو الباك إند لسه مش على GitHub:

```bash
cd D:/1Moaz/a_center_system/edu-center-backend
git init
git add -A
git commit -m "backend"
```

وبعدين اعمل repo **private** على GitHub وارفع عليه.

> ⚠ اتأكد إن `.env` مش مرفوع — موجود في `.gitignore` أصلاً، بس
> بص على الملفات قبل ما ترفع.

---

## ٣) السيرفر على Render — ٥ دقايق

1. [render.com](https://render.com) → سجّل بـGitHub
2. **New → Web Service** → اختار الريبو
3. Render هيقرا `render.yaml` لوحده، فمش هتكتب أوامر بإيدك.
   لو سألك، دي القيم:

   | | |
   |---|---|
   | Runtime | Node |
   | Build | `npm ci && npx prisma generate && npx prisma migrate deploy` |
   | Start | `npm start` |
   | Plan | Free |
   | Region | Frankfurt |

4. في **Environment** حط القيم دي:

   ```
   DATABASE_URL        = اللي خدته من Neon
   PORTAL_BASE_URL     = https://اسم-الخدمة.onrender.com
   ALLOWED_ORIGINS     = https://اسم-الخدمة.onrender.com
   SEED_ADMIN_EMAIL    = إيميلك
   SEED_ADMIN_PASSWORD = باسورد جديد (١٠ حروف على الأقل)
   ```

   `JWT_SECRET` بيتولّد لوحده · `NODE_ENV` و`BACKUP_ENABLED`
   جايين من `render.yaml`.

   > ⚠ لينك الخدمة بيظهر بعد أول نشر. يعني هتنشر مرة، تاخد
   > اللينك، تحطه في المتغيرين، وتعمل **Manual Deploy** تاني.
   > من غير الخطوة دي الـQR هيشاور على مكان غلط.

5. استنى النشر. آخر سطر لازم يكون:
   ```
   🚀 Server running on http://localhost:10000
   ```

6. افتح `https://اسم-الخدمة.onrender.com/api/health` → لازم ترد
   JSON.

---

## ٤) أول حساب

في Render → **Shell** (تبويب جنب Logs):

```bash
npm run db:seed
```

ده بيعمل: سنتر تجريبي + فرع + حسابك كـ **مالك النظام**
بالإيميل والباسورد اللي حطيتهم فوق.

> ⚠ لو شغّلته من غير `SEED_ADMIN_*` هيرفض ويقولك ليه — عشان
> الباسوردات الافتراضية مكتوبة في الريبو، ولو السيرفر على
> الإنترنت تبقى معروفة لأي حد.

---

## ٥) وجّه البرنامج على السيرفر

```bash
cd D:/1Moaz/a_center_system/center_system
flutter build windows --dart-define=API_BASE_URL=https://اسم-الخدمة.onrender.com/api
```

النسخة اللي في `build/windows/x64/runner/Release` بقت بتكلّم
السيرفر العام. و`flutter run` العادي فاضل على `localhost` زي ما
هو — نفس الكود، نسختين.

---

## ٦) جرّب

1. ادخل بحسابك → اعمل سنتر وفرع وموظف
2. افتح **طلبات التسجيل** → اعمل رابط → **احفظ الـQR**
3. امسحه **ببيانات الموبايل** (اقفل الواي فاي) — لازم يفتح
   صفحة التسجيل

لو فتحت، يبقى السيستم كله على الإنترنت فعلاً.

---

## حاجات تتوقعها في الخطة المجانية

| | |
|---|---|
| **النومة** | بعد ١٥ دقيقة سكوت. أول طلب بعدها ٣٠–٥٠ ثانية. الطالب اللي بيمسح الـQR هيستنى. |
| **SSE** | بيتقطع مع كل نومة، والبرنامج بيعيد الاتصال لوحده. |
| **الهارد** | بيتمسح مع كل نشر — عشان كده الباك أب المحلي متقفل. باك أب Neon هو الأساس. |
| **٧٥٠ ساعة/شهر** | كفاية لخدمة واحدة شغالة طول الشهر. |

أول سنتر حقيقي يشتغل → **Starter بـ٧ دولار/شهر** وتختفي النومة.

---

## بعد كده: الدومين

لما تشتري دومين (`markazi.com` بـ~١٢ دولار/سنة):

1. حطه على **كلاود فلير** (مجانية) — DNS وSSL
2. `CNAME  *  →  اسم-الخدمة.onrender.com`
3. غيّر `PORTAL_BASE_URL` لدومينك

وساعتها كل سنتر ياخد `اسمه.markazi.com` من الـ`slug` اللي موجود
أصلاً في جدول السناتر — من غير أي فلوس زيادة.
