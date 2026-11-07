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

## ۱. راه‌اندازی سرور ابری ۲۴ ساعته رایگان در Hugging Face Spaces (روش ۲)
1. در سایت [huggingface.co/new-space](https://huggingface.co/new-space) یک Space جدید با **SDK = Docker** (قالب Blank) بسازید.
2. سه فایل `Dockerfile`، `server.mjs` و همین `README.md` را در آن آپلود کنید.
3. در بخش **Settings → Variables and secrets** یک **New secret** با نام `CP_TOKEN` و یک رمز دلخواه ثبت کنید.
4. پس از سبز شدن وضعیت (`Running`)، آدرس مستقیم Space خود (مثلاً `https://USERNAME-SPACE.hf.space`) و `CP_TOKEN` را در پنجرهٔ **«🐧 ترمینال، Termux و سندباکس»** داخل خود سایت CodePilot وارد و ذخیره کنید.

## ۲. اتصال مستقیم Termux روی گوشی اندروید بدون تونل (روش ۳ — `127.0.0.1:8787`)
در خود سایت CodePilot، از منوی بالای صفحه دکمهٔ **«📱 Termux / سندباکس»** را بزنید، حالت **«پل مستقیم Termux محلی»** را انتخاب کنید و دکمهٔ **«📋 کپی دستور نصب و اجرای خودکار در Termux»** را بزنید و در Termux اجرا کنید. مرورگر کروم روی همان گوشی مستقیماً از طریق `http://127.0.0.1:8787` (با پشتیبانی از استاندارد Chrome Private Network Access) به Termux متصل می‌شود.
