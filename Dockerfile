# نسخة واحدة تشتغل على أي استضافة بتفهم Docker
# (Hugging Face Spaces · Koyeb · Back4App · أي VPS)
#
# ⚠ مابتحطش أسرار جوه الصورة. كل حاجة بتيجي من متغيرات البيئة
#   وقت التشغيل — زي Render بالظبط.
FROM node:20-slim

# ⚠ openssl مطلوب لـPrisma على صور slim، من غيره بيقع عند أول
#   استعلام برسالة غامضة عن المحرك.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ⚠ الـschema بينسخ هنا مع الـpackage files عشان `prisma generate`
#   اللي في نفس السطر تحت يلاقيه — ولو الكود اتغيّر والحزم لأ،
#   Docker بيستعمل الكاش ومابيسطّبش من أول وجديد.
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && npx prisma generate

COPY . .

# Hugging Face Spaces بيسمع على 7860 افتراضيًا.
# أي استضافة تانية بتبعت PORT بتاعها والكود بياخده (src/index.js).
ENV PORT=7860
EXPOSE 7860

# ⚠ الهجرات بتمشي قبل السيرفر. آمنة لو اتعادت — بتقول
#   "No pending migrations" وتكمّل.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
