# راه‌اندازی Cloudflare — چک‌لیست کوتاه

> **خطای «Access is not configured» چه معنایی دارد؟**
> سرور `ACCESS_TEAM_DOMAIN` و/یا `ACCESS_AUD` را پیدا نکرده است. دو راه دارید:
> **الف) فعال‌سازی فوری (تک‌کاربره)** — فقط یک متغیر اضافه کنید (بخش ۰).
> **ب) راه‌اندازی کامل Access** — بخش‌های ۱ تا ۴.
>
> برای دیدن دقیقاً چه چیزی کم است: `curl -s https://<سایت>/api/health | jq`

## ۰. فعال‌سازی فوری بدون Cloudflare Access (تک‌کاربره)

اگر الان فقط می‌خواهید کار کنید و Access را بعداً تنظیم کنید:

```bash
npx wrangler pages secret put SESSION_SECRET     # openssl rand -base64 32
npx wrangler pages secret put MODEL_API_KEY      # کلید tooken.club
```

و در **Settings → Variables and Secrets → Add** (نوع: *Variable* نه Secret):

```
DEV_ACCESS_EMAIL = your-email@example.com
```

نتیجه: سایت با یک هویت ثابت بالا می‌آید و یک **نوار هشدار زرد** در بالای صفحه
می‌گوید ورود واقعی نیست. `/api/health` هم `authMode: "dev-fallback"` برمی‌گرداند.

> ⚠️ در این حالت **هر کسی که آدرس سایت را بداند** می‌تواند گفتگوها و فایل‌ها را ببیند.
> این حالت را فقط برای آزمایش یا پشت یک لایه‌ی دیگر (Cloudflare WAF / URL مخفی) استفاده کنید.
>
> اگر بعداً `ACCESS_TEAM_DOMAIN` را تنظیم کنید، سرور به‌جای حالت تک‌کاربره، خطای
> `auth_conflict` می‌دهد تا مجبور شوید انتخاب کنید — این عمدی است.


## مسیر کامل (چند کاربر / امن واقعی)

بدون این مراحل، برنامه اجرا می‌شود ولی همگام‌سازی بین دستگاه‌ها و حافظه‌ی پایدار **کار
نمی‌کند**. ترتیب را رعایت کنید.

## ۱. D1

```bash
npx wrangler login
npx wrangler d1 create codepilot-db
# database_id خروجی را در wrangler.toml بگذارید
npx wrangler d1 execute codepilot-db --remote --file=./schema.sql   # اختیاری
```

داشبورد: **Workers & Pages → پروژه‌ی CodePilot → Settings → Functions → D1 database
bindings → Add** → Variable name: `DB` → Database: `codepilot-db`.

## ۲. Secrets

```bash
openssl rand -base64 32
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put MODEL_API_KEY
npx wrangler pages secret put ACCESS_TEAM_DOMAIN      # myteam.cloudflareaccess.com
npx wrangler pages secret put ACCESS_AUD             # Application Audience Tag
```

اختیاری: `MODEL_NAME`, `MODEL_BASE_URL`, `CONTEXT_BUDGET_TOKENS`, `ACCESS_ALLOWED_EMAILS`.

## ۳. Cloudflare Access

Zero Trust → Access → Applications → **Add an application → Self-hosted**:

1. دامنه: `codepilot.pages.dev` (و دامنه‌ی شخصی اگر دارید)
2. Policy: `Allow` برای ایمیل خودتان
3. از تنظیمات اپلیکیشن، **AUD Tag** را کپی و در `ACCESS_AUD` بگذارید
4. **Team domain** را در `ACCESS_TEAM_DOMAIN` بگذارید

بدون Access: `/api/*` با `401` و کد `access_required` پاسخ می‌دهد و UI صفحه‌ی ورود امن
نشان می‌دهد. این رفتار عمدی است، نه باگ.

## ۴. انتشار

```bash
npx wrangler pages deploy . --project-name=<نام-پروژه>
```

یا اتصال مخزن GitHub به Pages تا هر Commit خودکار منتشر شود.

## ۵. بررسی سلامت

| بررسی | نتیجه‌ی درست |
| --- | --- |
| باز کردن سایت بدون ورود | صفحه‌ی ورود Access |
| `/api/auth` بعد از ورود | `{"signedIn":true,...}` |
| `/api/config` | `{"storage":"d1",...}` |
| ساخت گفتگو → رفرش | گفتگو باقی می‌ماند |
| ورود با دستگاه دوم | همان گفتگوها دیده می‌شوند |
| ارسال پیام | رویدادهای `tool`/`assistant`/`done` و ذخیره‌ی پیام |

## ۶. اگر خطا دیدید

| پیام | معنا | کار |
| --- | --- | --- |
| `Access is not configured.` | **کد قدیمی** روی `main`؛ یعنی نسخه‌ی جدید منتشر نشده | PR را merge و دوباره Deploy کنید |
| `access_unconfigured` | `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` نیست یا قالب اشتباه است | بخش ۰ یا مرحله ۳ |
| `auth_conflict` | هم `DEV_ACCESS_EMAIL` و هم `ACCESS_TEAM_DOMAIN` تنظیم شده | یکی را بردارید |
| `session_secret_missing` | `SESSION_SECRET` نیست یا < ۳۲ کاراکتر | `openssl rand -base64 32` |
| `db_missing` | اتصال `DB` نیست | مرحله ۱ |
| `model_key_missing` | `MODEL_API_KEY` نیست | مرحله ۲ |
| `model_auth` | ارائه‌دهنده کلید را رد کرد | کلید را در Secrets به‌روز کنید |
| `cross_origin` | درخواست از دامنه‌ی دیگر | از خود دامنه‌ی Pages استفاده کنید |
| `email_not_allowed` | ایمیل در `ACCESS_ALLOWED_EMAILS` نیست | لیست را اصلاح کنید |

## ۷. اجرای واقعی کد (اختیاری — Sandbox)

بدون این بخش، `run_command` فقط شل مجازی است و همین را هم صریح می‌گوید. برای اجرای واقعی:

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "SANDBOX"
class_name = "Sandbox"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Sandbox"]
```

سپس یک Durable Object به نام `Sandbox` بسازید که `fetch` را روی یک Container با ایمیج
لینوکس اجرا کند و قرارداد زیر را رعایت کند:

```jsonc
// POST https://sandbox.internal/run
// request
{ "cmd": "npm test", "cwd": "/workspace", "timeoutMs": 20000,
  "files": { "app.js": "…" } }        // فایل‌ها قبل از اجرا در /workspace نوشته شوند
// response
{ "ok": true, "exitCode": 0, "stdout": "…", "stderr": "", "durationMs": 812 }
```

تا وقتی این بایندینگ وجود نداشته باشد:
- `/api/config` مقدار `sandbox:false` می‌دهد،
- هدر ترمینال «شل مجازی و امن» می‌ماند،
- و هیچ‌جا ادعا نمی‌شود فرمانی واقعاً اجرا شده است.

## نکات امنیتی

- `MODEL_API_KEY` و `SESSION_SECRET` را در `wrangler.toml` یا کد نگذارید؛ فقط Secret.
- توکن GitHub را در فایل پروژه، چت یا حافظه نگذارید (در غیر این صورت پاک‌سازی می‌شود).
- اگر توکنی جایی لو رفت، همان لحظه در GitHub باطلش کنید.
- سیاست Access را روی «فقط ایمیل خودتان» بگذارید؛ هر کاربر مجاز، پایگاه‌داده‌ی مشترک
  ندارد اما به همان پروژه دسترسی دارد.
