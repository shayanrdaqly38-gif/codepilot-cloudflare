# CodePilot — محیط کدنویسی هوشمند روی Cloudflare

ویرایشگر کد در مرورگر + دستیار هوش مصنوعی با **حافظه‌ی پایدار در Cloudflare D1**.
گفتگوها، پیام‌ها، زمان، شناسه و خلاصه‌ی حافظه در پایگاه‌داده ذخیره می‌شوند؛ با هر دستگاه
دیگری که با **همان حساب Cloudflare Access** وارد شوید، همان گفتگوها و همان فایل‌های کاری
را برمی‌دارید. `localStorage` فقط کشِ توکن GitHub و آخرین گفتگوی باز است.

> **صادقانه:** همگام‌سازی بین دستگاه‌ها تنها وقتی کار می‌کند که مراحل بخش
> [راه‌اندازی](#راه‌اندازی-دستی-در-cloudflare) واقعاً روی حساب Cloudflare شما انجام شده باشد.
> کد به‌تنهایی چیزی را همگام نمی‌کند.

## چه چیزی در این گام ساخته شد

| بخش | جزئیات |
| --- | --- |
| ورود امن | Cloudflare Access (RS256/JWKS) → کوکی نشست امضاشده با HMAC، `HttpOnly`, `SameSite=Strict` |
| پایگاه‌داده | D1 با جدول‌های `users`, `conversations`, `messages`, `memories`, `usage_daily`, `rate_limits`, `meta` |
| پیام‌ها | ترتیب پایدار با `seq`، ذخیره‌ی پیش از فراخوانی مدل، بازیابی گروه کامل `assistant/tool_calls/tool` |
| حافظه‌ی بلندمدت | خلاصه‌ی چرخشی گفتگو + ردیف‌های حافظه‌ی قابل‌ویرایش توسط کاربر |
| پنجره‌ی زمینه | بودجه‌ی توکن، برش فقط از مرز پیام کاربر، خلاصه‌سازی بخش‌های قدیمی |
| ابزارها | `list_files`, `read_file`, `write_file`, `run_command` — سمت سرور، شل مجازی بدون شبکه |
| رازداری | پاک‌سازی کلید/توکن در پیام‌ها، حافظه، خروجی ابزار و پاسخ مدل؛ کلیدها فقط در Secrets |
| محدودیت مصرف | سقف درخواست در دقیقه/روز به‌ازای هر حساب (`rate_limits`) |
| تست | ۲۱ تست بک‌اند (SQLite واقعی + Access جعلی) و تست دودی رابط کاربری |
| UI | استریم SSE، ترمینال مجازی، کاوشگر فایل، تنظیمات حافظه، خروجی JSON و حذف داده |

## ساختار پروژه

```
index.html                              رابط کاربری (فارسی، RTL)
schema.sql                              طرح D1 برای ساخت دستی
wrangler.toml                           اتصال D1 و متغیرهای غیرحساس
functions/api/auth.js                   GET/POST /api/auth
functions/api/config.js                 GET /api/config
functions/api/chat.js                   POST /api/chat  (SSE، حلقه‌ی ابزار)
functions/api/state/index.js            GET/POST /api/state (bootstrap، export، delete)
functions/api/state/conversations/index.js
functions/api/state/conversations/[id].js
functions/api/state/memory/index.js
functions/api/state/usage.js
functions/_lib/auth.js                  Access + کوکی نشست
functions/_lib/schema.js                ساخت/مهاجرت خودکار D1
functions/_lib/store.js                 لایه‌ی داده (همه‌چیز scoped به owner)
functions/_lib/memory.js                پنجره‌ی زمینه، خلاصه‌سازی، repair گروه tool
functions/_lib/model.js                 تماس با ارائه‌دهنده‌ی مدل (کلید فقط در سرور)
functions/_lib/limits.js                محدودیت نرخ به‌ازای هر حساب
functions/_lib/api.js                   گارد مشترک: مبدأ، نشست، اسکیمای D1
functions/_lib/util.js                  Redaction، رمزنگاری، خطاها
tests/                                  تست‌های Node (SQLite واقعی + jsdom)
```

## راه‌اندازی دستی در Cloudflare

### ۱) ساخت پایگاه‌داده D1

```bash
npx wrangler login
npx wrangler d1 create codepilot-db
```

خروجی یک `database_id` می‌دهد. آن را در `wrangler.toml` جای
`REPLACE_WITH_YOUR_D1_DATABASE_ID` بگذارید.

```bash
# اختیاری ولی توصیه‌شده: ساخت جدول‌ها به‌صورت صریح
npx wrangler d1 execute codepilot-db --remote --file=./schema.sql
```

> برنامه خودش هم در اولین درخواست، جدول‌های لازم را می‌سازد و ستون‌های نسخه‌های قدیمی
> را اضافه می‌کند (`functions/_lib/schema.js`). اجرای دستی فقط برای شفافیت و بازبینی است.

### ۲) اتصال D1 به پروژه‌ی Pages

اگر از داشبورد استفاده می‌کنید: **Workers & Pages → پروژه → Settings → Functions →
D1 database bindings → Add**: نام متغیر **`DB`** و همان دیتابیس `codepilot-db`.

اگر با Wrangler منتشر می‌کنید، همان `wrangler.toml` اتصال را می‌سازد.

### ۳) Secrets (نه متغیرهای عادی)

```bash
openssl rand -base64 32            # برای SESSION_SECRET

npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put MODEL_API_KEY
```

| نام | الزامی | توضیح |
| --- | --- | --- |
| `SESSION_SECRET` | ✅ | حداقل ۳۲ کاراکتر تصادفی؛ امضای کوکی نشست |
| `MODEL_API_KEY` | ✅ | کلید ارائه‌دهنده‌ی مدل؛ فقط در سرور می‌ماند |
| `ACCESS_TEAM_DOMAIN` | ✅ | مثل `myteam.cloudflareaccess.com` |
| `ACCESS_AUD` | ✅ | Audience Tag اپلیکیشن Access |
| `MODEL_NAME` | — | پیش‌فرض `gpt-4o-mini` |
| `MODEL_BASE_URL` | — | پیش‌فرض `https://tooken.club/v1` |
| `CONTEXT_BUDGET_TOKENS` | — | پیش‌فرض `24000` |
| `ACCESS_ALLOWED_EMAILS` | — | فهرست ایمیل‌های مجاز با کاما (اختیاری) |
| `CHAT_LIMIT_PER_MINUTE` | — | پیش‌فرض `12` |
| `CHAT_LIMIT_PER_DAY` | — | پیش‌فرض `400` |

سه مورد اول را می‌توانید در داشبورد هم بگذارید:
**Settings → Variables and Secrets → Add → Secret**.

### ۴) Cloudflare Access

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

- دامنه: دامنه‌ی Pages (`codepilot.pages.dev` و/یا دامنه‌ی شخصی)
- Policy: مثلاً فقط ایمیل خودتان (یا Google/GitHub login)
- از صفحه‌ی اپلیکیشن، **Application Audience (AUD) Tag** را بردارید و در `ACCESS_AUD` بگذارید
- **Team domain** را در `ACCESS_TEAM_DOMAIN` بگذارید

Access کل سایت را می‌پوشاند. بدون آن، همه‌ی `/api/*` با `401` پاسخ می‌دهند و UI صفحه‌ی
«ورود امن لازم است» نشان می‌دهد.

### ۵) توکن Commit به GitHub (اختیاری)

این توکن *هویت کاربر نیست*: فقط اجازه‌ی نوشتن روی یک مخزن است و در `localStorage` همان
مرورگر می‌ماند. یک **fine-grained token** با دسترسی `Contents: Read and write` فقط روی
همان مخزن بسازید. توکن هرگز به D1، حافظه یا مدل فرستاده نمی‌شود.

## اجرای محلی

```bash
npm install
npm run dev            # wrangler pages dev . --d1 DB=codepilot-db
cp .dev.vars.example .dev.vars   # سپس مقادیر را پر کنید
```

## تست‌ها

```bash
npm test        # ۲۱ تست: احراز هویت، CRUD، حافظه، خلاصه‌سازی، رازداری، محدودیت نرخ، همگام‌سازی، مهاجرت
npm run test:ui # تست دودی رابط کاربری در jsdom (استریم SSE، رندر ابزار، ذخیره‌ی خودکار)
npm run test:all
```

تست‌ها به `jsdom` نیاز دارند (`npm install`). پایگاه‌داده در تست‌ها SQLite واقعی است
(`node:sqlite`) و با یک شبیه‌ساز D1 اجرا می‌شود؛ Access هم با JWKS و JWT محلی شبیه‌سازی
می‌شود، بنابراین همان کد تولیدی اجرا می‌شود.

برای ورود محلی یا `Cf-Access-Jwt-Assertion` واقعی لازم است یا باید سراغ
`wrangler pages dev` با Access واقعی رفت. بدون Access، API عمداً `401` می‌دهد.

## قرارداد API

| مسیر | متد | کار |
| --- | --- | --- |
| `/api/auth` | GET | هویت کاربر، صدور کوکی نشست |
| `/api/auth` | POST | خروج (پاک‌کردن کوکی) |
| `/api/config` | GET | پیکربندی غیرحساس |
| `/api/state` | GET | یک‌جا: کاربر، گفتگوها، حافظه، مصرف |
| `/api/state` | POST | `create`, `rename`, `flags`, `delete`, `append`, `replace-messages`, `workspace`, `memory-upsert`, `memory-delete`, `export`, `delete-all` |
| `/api/state/conversations` | GET | فهرست سبک گفتگوها |
| `/api/state/conversations/:id` | GET | گفتگو + پیام‌ها + خلاصه + workspace |
| `/api/state/memory` | GET/POST | فهرست/افزودن/حذف حافظه |
| `/api/state/usage` | GET | مصرف روزانه |
| `/api/chat` | POST | یک نوبت گفتگو، پاسخ `text/event-stream` |

رویدادهای استریم: `status`, `tool`, `tool_result`, `assistant`, `done`, `error`.

## تصمیم‌های طراحی که باید بدانید

1. **پیام کاربر قبل از فراخوانی مدل ذخیره می‌شود.** اگر مدل قطع شود، پیام از دست نمی‌رود.
2. **خلاصه‌سازی فقط از مرز پیام `user` بریده می‌شود** تا `assistant.tool_calls` از
   نتیجه‌هایش جدا نشود. `repairToolGroups` هر گروه ناقص را حذف می‌کند.
3. **برش زمینه با بودجه‌ی توکن** انجام می‌شود، نه با تعداد پیام. اگر بودجه‌ی درخواست
   رد شود، پاسخ `413` با پیام روشن برمی‌گردد.
4. **هر کوئری با `owner` محدود است.** شناسه‌ی گفتگوی کاربر دیگر → `404`.
5. **CSRF:** هر `POST` باید `Origin` هم‌مبدأ داشته باشد (`Sec-Fetch-Site` هم بررسی می‌شود).
6. **رازداری چندلایه:** ورودی کاربر، حافظه، خروجی ابزار و پاسخ مدل همه پاک‌سازی می‌شوند.
   الگوهای token شکل (GitHub, OpenAI, AWS, Google, Slack, JWT, کلید خصوصی) و
   `api_key = "..."` جایگزین می‌شوند.
7. **کلید مدل هرگز به مرورگر نمی‌رسد.** `/api/config` فقط نام مدل و بودجه را می‌دهد.

## محدودیت‌های شناخته‌شده

- شل، **مجازی** است: `ls`, `cat`, `touch`, `echo >`, `rm` روی فایل‌های workspace. هیچ
  فرمان OS یا دسترسی شبکه‌ای اجرا نمی‌شود.
- Commit به GitHub از مرورگر انجام می‌شود (توکن آنجاست). اگر مرورگر بسته شود، فایل در D1
  ذخیره است و در نوبت بعدی/Commit بعدی منتقل می‌شود.
- سقف‌ها: ۲۰۰ فایل در workspace، ۴۰۰۰ پیام در هر گفتگو، ۳۰۰ گفتگو در هر کاربر،
  ۱۲ درخواست در دقیقه و ۴۰۰ در روز برای هر حساب (قابل تنظیم).
- اجرای Durable Object / اجرای چنددستگاهی هم‌زمان (CRDT) در این گام نیست؛ آخرین نوشتن
  برنده است و `revision` جلوی نوشتن روی نسخه‌ی کهنه را می‌گیرد.

## نقشه‌ی گام‌های بعدی (پیشنهاد)

این گام «حافظه و ذخیره‌سازی پایدار» را کامل می‌کند. برای نزدیک‌شدن بیشتر به یک محیط
کدنویسی کامل، ترتیب پیشنهادی:

1. **اجرای واقعی کد** — `wrangler`/Durable Object یا Sandbox جدا؛ الان شل عمداً مجازی است.
2. **تفکیک workspace از گفتگو** — پروژه‌ی مستقل با نسخه‌بندی فایل، تا گفتگوهای متعدد روی
   یک پروژه کار کنند.
3. **جست‌وجوی کد** — ایندکس FTS5 در D1 برای پیدا کردن نمادها بین فایل‌ها.
4. **ویرایش تفاضلی** — ابزار `apply_patch` به‌جای نوشتن کل فایل.
5. **همگام‌سازی هم‌زمان** — Durable Object برای جلوگیری از تعارض دو دستگاه در یک لحظه.
