# 📋 گزارش بررسی کامل پروژه CodePilot

> تاریخ بررسی: ۲۰۲۶-۱۱-۰۸ · شاخه: `arena/ca7a2d31-codepilot-cloudflare` · کامیت: `0b9e2a2`
>
> **✅ وضعیت: همه‌ی ۸ اصلاح انجام و در کامیت `58ba3e0` پوش شد.**
> نتیجه‌ی نهایی: **۹۰/۹۰ تست بک‌اند + تست دودی UI با ۲۲۵ assertion — همه سبز**
> (قبل از اصلاحات: ۸۴ تست بک‌اند سبز، تست UI در خط ۸۲۰ کرش می‌کرد.)

---

## ۱) معرفی کلی پروژه

**CodePilot** یک محیط کدنویسی هوشمند (AI Coding Workspace) کاملاً فارسی و RTL است که روی **Cloudflare Pages + D1** اجرا می‌شود. کاربر در مرورگر با یک ایجنت گفتگو می‌کند که می‌تواند فایل بخواند/بنویسد، کد را ویرایش کند، جست‌وجو کند، فرمان اجرا کند، وب را بکاود و تصویر بسازد — همه با حافظه‌ی پایدار در پایگاه‌داده D1.

### آمار کلی

| شاخص | مقدار |
|---|---|
| کل خطوط کد (بدون node_modules) | **~۳۴,۳۰۰ خط** |
| `index.html` (UI تک‌فایله: HTML+CSS+JS) | ۹,۶۶۵ خط (~۴۷۸KB) |
| بک‌اند (`functions/`) | ~۱۵,۲۰۰ خط در ۳۸ فایل |
| تست‌ها | ۱۳ فایل تست |
| بزرگ‌ترین فایل بک‌اند | `functions/_lib/model.js` (۳,۸۲۸ خط) |
| تاریخچه‌ی گیت | تک‌کامیت (squash شده) — `0b9e2a2` |

### سه جزء اصلی

```
┌────────────────────────────────────────────────────────────┐
│ index.html  ← UI تک‌صفحه‌ای فارسی/RTL + PWA (manifest)      │
├────────────────────────────────────────────────────────────┤
│ functions/  ← بک‌اند Cloudflare Pages Functions             │
│   api/chat.js (حلقه‌ی ایجنت SSE) + _lib/* (۱۹ ماژول)       │
├────────────────────────────────────────────────────────────┤
│ runner-kit/ ← سرور اجرای واقعی Node (بدون وابستگی)         │
│   Hugging Face Spaces (Docker) یا Termux اندروید           │
└────────────────────────────────────────────────────────────┘
```

---

## ۲) معماری و امکانات (چه چیزی وجود دارد)

### 🔐 احراز هویت (`functions/_lib/auth.js` — ۳۸۲ خط)
- Cloudflare Access با تأیید RS256 JWT روی JWKS کش‌شده (TTL ۱۰ دقیقه)
- صدور کوکی نشست امضاشده HMAC (`cp_session`، ۱۲ ساعت، HttpOnly، SameSite=Strict)
- حالت تک‌کاربره‌ی سریع: `DEV_ACCESS_EMAIL`
- استخراج کلید نشست از `MODEL_API_KEY` با domain-separator اگر `SESSION_SECRET` ست نشده باشد (با هش SHA-256، کلید خام قابل بازیابی نیست)
- لیست ایمیل‌های مجاز (`ACCESS_ALLOWED_EMAILS`)

### 🗄️ پایگاه‌داده D1 (`functions/_lib/schema.js`)
- **۱۴ جدول**: `users`, `conversations`, `messages`, `memories`, `workspace_files`, `workspace_file_chunks`, `file_versions`, `uploads`, `upload_chunks`, `generated_images`, `generated_image_chunks`, `usage_daily`, `rate_limits`, `meta`
- مهاجرت خودکار و idempotent — `SCHEMA_VERSION = 9` (بوتstrap در اولین درخواست)
- همه‌ی کوئری‌ها owner-scoped (جداسازی داده‌ی کاربران)

### 🤖 حلقه‌ی ایجنت (`functions/api/chat.js` — ۲,۰۶۵ خط)
- `POST /api/chat` با پاسخ استریمی SSE (رویدادهای `status`, `tool`, `tool_result`, `assistant`, `done`, `error`)
- پیام کاربر **قبل از** فراخوانی مدل ذخیره می‌شود (ضد از دست رفتن)
- **۱۴ ابزار**: `think`, `list_files`, `read_file`, `search_code`, `list_symbols`, `apply_patch`, `write_file`, `delete_file`, `undo_edit`, `file_history`, `run_command`, `web_search`, `fetch_url`, `generate_image`
- توقف تولید (`/api/chat/stop`) + چک‌پوینت نوبت و ادامه از نقطه‌ی قطع (`_lib/checkpoint.js`, `_lib/turn-registry.js`)
- `repairToolGroups` برای سلامت ساختار پیام‌های tool در تاریخچه

### 🧠 لایه‌ی مدل (`functions/_lib/model.js` + `provider.js` — ۵,۱۰۰ خط با هم)
- **استخر ۱۰ درگاه (Gateway Pool)** با failover و health-tracking به‌ازای هر کاربر
- پشتیبانی از ارائه‌دهنده‌های متعدد: tooken.club، OpenRouter، Zro، OpenAI-سازگار سفارشی
- کلید API هر کاربر **رمزنگاری‌شده** در D1 ذخیره می‌شود
- کش سهمیه (rate-limit headers)، کش کاتالوگ مدل‌ها، کش کووتا
- کشف خودکار سطح Effort برای مدل‌های جدید + واریانت‌های wire reasoning
- بهینه‌ساز توکن (`_lib/token-optimizer.js` — ۶۹۱ خط) با حالت‌های `off/balanced/max/rpd`

### 🐧 اجرای واقعی کد (`functions/_lib/sandbox.js` + `runner-kit/server.mjs`)
سه حالت — همه با صداقتِ کامل درباره‌ی محیط:
1. **شل مجازی** (پیش‌فرض): خروجی صریحاً می‌گوید مجازی است
2. **سرور ابری**: Docker روی Hugging Face Spaces (رایگان) — `runner-kit/` با تمام‌وکمال zero-dependency
3. **پل Termux محلی**: اتصال مستقیم مرورگر اندروید به `127.0.0.1:8787` (Chrome Private Network Access) با توکن timing-safe و CORS درست

### 🎨 استودیو تصویر (`functions/_lib/image.js` — ۷۲۷ خط)
- اتصال **Workers AI** بومی Cloudflare (FLUX.1 / Phoenix) — بدون کلید خارجی
- بهبود خودکار پرامپت فارسی، ذخیره‌ی chunk شده در D1، owner-isolated

### 🌐 ابزارهای وب (`functions/_lib/web.js` — ۵۷۹ خط)
- `web_search` چندمنبعی + `fetch_url` با **محافظت SSRF کامل** (loopback، RFC1918، metadata IP، ریدایرکت‌های re-validated)

### 🖥️ رابط کاربری (`index.html`)
- ۱۱ مودال (تنظیمات، مدل، سندباکس، استودیو تصویر، کووتا، GitHub، Codex، جست‌وجو، تاریخچه، پاور، لایت‌باکس)
- استریم SSE، ترمینال تعاملی، کاوشگر فایل، نسخه‌ها، حالت ماراتن، ۳ تم (`claude-warm`, `claude-day`, `midnight`)، PWA فول‌اسکرین موبایل
- `manifest.webmanifest` سالم (fa/rtl/fullscreen/maskable icon)

---

## ۳) وضعیت تست‌ها (اجرا شده توسط من)

| دستور | نتیجه |
|---|---|
| `npm test` (بک‌اند) | ✅ **۸۴ تست، همه پاس** (~۱۸.۵ ثانیه) |
| `npm run test:ui` (jsdom) | ❌ **کرش در خط ۸۲۰ از ۲۲۵ assertion** |
| `node --check` روی ۳۸ فایل بک‌اند | ✅ همه سالم |

تست‌های بک‌اند با SQLite واقعی (`node:sqlite`) + شبیه‌ساز D1 + JWKS/JWT محلی اجرا می‌شوند — همان کد production تحت تست است. کیفیت تست‌ها بالاست: `tools.test.mjs` (۷۱KB) حتی `index.html` واقعی ۴۸۰KB را validate می‌کند.

---

## ۴) 🔴 مشکلات پیدا شده (به ترتیب اهمیت)

### ۱. تست UI شکست می‌خورد — رگرسیون در `probeLocalTermux`
```
AssertionError: probeLocalTermux() IMMEDIATELY activates and persists
local-termux even before saveSandboxSettings()
  at tests/ui.test.mjs:820  (actual: false, expected: true)
```
تست انتظار دارد بعد از پروبِ موفقِ `127.0.0.1:8787/health`، حالت local-termux **بلافاصله** فعال شود (بروزرسانی `state.sandboxConfig` + `syncShellBadge()`) — اما پیاده‌سازی فعلی `probeLocalTermux()` در `index.html` (خط ۸۳۱۰) فقط نتیجه را در `#sbModalLocalProbeOut` نشان می‌دهد و حالت را فعال نمی‌کند؛ فعال‌سازی فقط بعد از `saveSandboxSettings()` رخ می‌دهد. **۲۸ assertion بعد از این خط هرگز اجرا نمی‌شوند** (شامل سناریوی کامل ترمینال Termux و سینک changedFiles). این یا رگرسیون کد است یا تست کهنه.

### ۲. `package.json` به ۵ فایل تستِ ناموجود ارجاع می‌دهد
اسکریپت `test` این فایل‌ها را می‌خواهد که **وجود ندارند**:
`tests/chat.test.mjs`, `tests/auth-modes.test.mjs`, `tests/deploy.test.mjs`, `tests/marathon.test.mjs` (+ `tests/artifacts.test.mjs` طبق README).
`node --test` فایل ناموجود را بی‌صدا نادیده می‌گیرد (`Could not find ...` ولی exit code صفر!) — یعنی این ارجاع‌های مرده **هرگز خودشان را نشان نمی‌دهند** و تعداد واقعی تستِ در حال اجرا پنهان است.

### ۳. README به‌شدت ناهمگام با کد شده
۱۲+ فایل/مسیر که README به آن‌ها ارجاع می‌دهد وجود ندارند:

| ارجاع در README | وضعیت |
|---|---|
| `schema.sql` | ❌ موجود نیست (دستور `npm run db:schema` هم می‌شکند) |
| `scripts/check-deploy.sh` | ❌ موجود نیست |
| `.dev.vars.example` | ❌ موجود نیست (راهنمای اجرای محلی `cp .dev.vars.example .dev.vars` شکست می‌خورد) |
| `functions/_lib/artifacts.js` | ❌ (قابلیت دانلود آرتیفکت در README توصیف شده ولی کدش حذف/هرگز نبوده) |
| `functions/api/artifacts/*` | ❌ |
| `functions/api/state/workspace-file.js` | ❌ |
| `tests/artifacts.test.mjs` و ۴ تست دیگر | ❌ |

همچنین README می‌گوید «۳۳ تست» ولی واقعاً ۸۴ تست اجرا می‌شود، و بخش «ساختار پروژه» اصلاً از امکانات موجود (استودیو تصویر، web_search/fetch_url، استخر درگاه، بهینه‌ساز توکن، آپلود چانکی، Codex، حالت‌های پاور) نام نمی‌برد.

### ۴. باقی‌مانده‌های بازی حذف‌شده‌ی «سوپر نُوا»
طبق `MARATHON.md` بازی و «تمام وابستگی‌های آن» حذف شده، ولی:
- `tests/super-nova.test.mjs` (۷.4KB) هنوز هست — `super-nova.html` حذف شده، پس اگر اجرایش کنید **کرش** می‌کند (خوشبختانه در package.json لیست نشده)
- `.tmp/nova-inline.js` (**۱۱۰KB**) + ۱۶ فایل دیگر (پچ‌های python، بنچمارک‌ها، probeها) در گیت کامیت شده‌اند
- `functions/_lib/game-core.test.mjs` یک فایل **خالی ۰ بایتی** است

### ۵. `ui_enhancements.js` کد مرده است
۱۷۴ خط کد a11y/UX (skip-link، focus-trap، announce برای اسکرین‌ریدر) نوشته شده ولی **هیچ‌جا به آن ارجاعی نیست** — `index.html` هیچ `<script src>` خارجی ندارد. یا باید لود شود یا حذف.

### ۶. `.gitignore` ناقص است
- `.tmp/` ignore نشده (همان دلیل مشکل ۴)
- `package-lock.json` هم ignore/مدیریت نشده (من موقع `npm install` ساخته شد؛ برای تمیزماندن ریپو حذفش کردم)

### ⚪ نکات جزئی
- `wrangler.toml` شامل `database_id` واقعی است — برای IaC لازم و **secret نیست**، اشکالی ندارد
- اسکن کلیدهای لو رفته: فقط fixture های تستی پیدا شد — ✅ تمیز
- `functions/api/run.js` فقط ۷۸ خط ولی در README توصیف نشده
- تک‌کامیت بودن تاریخچه (squash) باعث نمی‌شود رگرسیون مسئله ۱ قابل blame باشد

---

## ۵) ✅ نقاط قوت پروژه

1. **صداقت مهندسی** — هیچ‌جا اجرای واقعی جعل نمی‌شود؛ شل مجازی صریحاً «مجازی» است
2. **امنیت چندلایه** — SSRF guard، CSRF origin check، redaction رازها در ۴ لایه، owner-scoping همه‌ی کوئری‌ها، رمزنگاری کلید کاربر، timing-safe compare
3. **تست‌های واقعی** — SQLite واقعی نه mock؛ `index.html` خود پروژه هم validate می‌شود
4. **مهاجرت خودکار D1** — بدون نیاز به schema.sql دستی، backward-compatible تا نسخه ۸
5. **مدیریت خطای فارسی و قابل فهم** — پیام‌های خطا دقیقاً می‌گویند چه متغیری کم است
6. **runner-kit بی‌نیاز از وابستگی** — یک فایل Node خالص که همه‌جا اجرا می‌شود
7. **UI موبایل‌محور فارسی** — PWA فول‌اسکرین، ترمینال تعاملی، ۳ تم

---

## ۶) 🛠️ پیشنهاد اصلاحات (به ترتیب اولویت)

| # | اقدام | تلاش |
|---|---|---|
| ۱ | اصلاح `probeLocalTermux()` در `index.html` تا بعد از پروب موفق، حالت local-termux فوراً فعال شود (یا به‌روزرسانی تست اگر رفتار عمداً حذف شده) — تا `npm run test:all` سبز شود | کم |
| ۲ | پاک‌سازی `package.json`: حذف ۵ ارجاع تست مرده + افزودن `tests/super-nova.test.mjs` به نادیده‌گرفتن یا حذفش | خیلی کم |
| ۳ | حذف باقی‌مانده‌های سوپر نُوا: `tests/super-nova.test.mjs`، `functions/_lib/game-core.test.mjs`، کل `.tmp/` | خیلی کم |
| ۴ | افزودن `.tmp/` به `.gitignore` | خیلی کم |
| ۵ | تصمیم درباره `ui_enhancements.js`: لود کردن با `<script src>` یا حذف | کم |
| ۶ | بازنویسی README برای انطباق با کد فعلی (حذف ارجاعات آرتیفکت/schema.sql، افزودن مستندات استودیو تصویر، ابزارهای وب، استخر درگاه) | متوسط |
| ۷ | احیای `schema.sql` (تولید از `schema.js`) تا `npm run db:schema` کار کند | کم |
| ۸ | ساخت `.dev.vars.example` و `scripts/check-deploy.sh` که README وعده داده | کم |

---

## ۷) جمع‌بندی

پروژه از نظر **معماری، امنیت و کیفیت تست** در وضعیت بسیار خوبی است — ۸۴ تست بک‌اند سبز، بک‌اند کاملاً سالم از نظر سینتکس، بدون راز لو رفته. مشکل اصلی **بدهی فنی مستندات و بهداشت ریپو** است: README با کد ناهمگام شده، ارجاعات تست مرده وجود دارد، زباله‌های بازی حذف‌شده در گیت مانده و یک تست UI (که یک رگرسیون واقعی را گزارش می‌کند) قرمز است.

هر ۸ اصلاح پیشنهادی بالا در مجموع کمتر از یک روز کار است و پروژه را به حالت «کاملاً تمیز» می‌رساند.
