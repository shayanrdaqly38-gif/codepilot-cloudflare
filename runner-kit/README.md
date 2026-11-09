---
title: CodePilot Linux Runner
emoji: 🐧
colorFrom: orange
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# CodePilot Universal Linux & Termux Runner (`runner-kit`)

این بسته شامل سرور اجرای واقعی لینوکس و Termux برای **CodePilot** است و هر دو حالت را پشتیبانی می‌کند:

## ۱. راه‌اندازی سرور ابری ۲۴ ساعته

### گزینه‌ی رایگان پیشنهادی — Render.com 🆓
1. در گیت‌هاب یک ریپوی **عمومی** جدید بسازید و این دو فایل را در آن بگذارید: `server.mjs` (از همین پوشه) و یک `package.json` با این محتوا:
   ```json
   { "name": "codepilot-runner", "type": "module", "scripts": { "start": "node server.mjs" } }
   ```
2. در [render.com](https://render.com) با همان اکانت گیت‌هاب ثبت‌نام کنید ← **New + → Web Service** ← ریپو را وصل کنید ← پلن **Free**.
3. در بخش **Environment** متغیر `CP_TOKEN` را با یک رمز دلخواه بسازید.
4. لینک سرویس (مثل `https://codepilot-runner.onrender.com`) و `CP_TOKEN` را در پنجرهٔ **«🐧 ترمینال، Termux و سندباکس»** داخل خود سایت CodePilot وارد و ذخیره کنید.
5. نکته: سرویس رایگان بعد از ۱۵ دقیقه بی‌کاری می‌خوابد (~۱ دقیقه طول می‌کشد بیدار شود).

### Hugging Face Spaces (نیازمند اشتراک PRO)
> ⚠️ از ۲۰۲۵ به بعد، اکانت‌های رایگان هگینگ‌فیس برای Spaceهای جدید فقط **ZeroGPU** می‌گیرند (که برای این رانر مناسب نیست) و Docker و cpu-basic شده فقط برای مشترکین PRO. اگر PRO دارید:
1. در [huggingface.co/new-space](https://huggingface.co/new-space) یک Space با **SDK = Docker** (قالب Blank) بسازید.
2. فایل‌های `Dockerfile`، `server.mjs` و همین `README.md` را در آن آپلود کنید.
3. در بخش **Settings → Variables and secrets** یک **New secret** با نام `CP_TOKEN` ثبت کنید.
4. پس از `Running` شدن، آدرس Space (مثلاً `https://USERNAME-SPACE.hf.space`) و `CP_TOKEN` را در CodePilot وارد کنید.

### VPS / هر میزبان Docker
فایل `Dockerfile` همین پوشه را اجرا کنید (`docker build` + `docker run -p 7860:7860 -e CP_TOKEN=...`) و پورت ۷۸۶۰ را منتشر کنید.

## ۲. اتصال مستقیم Termux روی گوشی اندروید بدون تونل (روش ۳ — `127.0.0.1:8787`)
در خود سایت CodePilot، از منوی بالای صفحه دکمهٔ **«📱 Termux / سندباکس»** را بزنید، حالت **«پل مستقیم Termux محلی»** را انتخاب کنید و دکمهٔ **«📋 کپی دستور نصب و اجرای خودکار در Termux»** را بزنید و در Termux اجرا کنید. مرورگر کروم روی همان گوشی مستقیماً از طریق `http://127.0.0.1:8787` (با پشتیبانی از استاندارد Chrome Private Network Access) به Termux متصل می‌شود.

## ۳. نکته‌ی آپگرید (v2.3.1+)
از v2.3.0 هر گفتگو یک پوشه‌ی کاری جدا در `sessions/<conversationId>` می‌گیرد. اگر رانر را روی یک نصب قدیمی (که همه‌چیز در ریشه‌ی مشترک بود) آپدیت کنید، **اولین** گفتگویی که دستور اجرا کند، محتوای قدیمی ریشه را یک‌بار برای همیشه به پوشه‌ی خودش منتقل می‌کند (فایل‌های تازه‌تر سمت D1 هرگز بازنویسی نمی‌شوند؛ نشانه‌ی `.cp-legacy-adopted` جلوی تکرار را می‌گیرد). یعنی آپدیت رانر هیچ‌وقت «گم شدن» فایل‌های روی دیسک باعث نمی‌شود.
