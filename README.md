# CodePilot — محیط کدنویسی هوشمند روی Cloudflare

ویرایشگر کد در مرورگر + دستیار هوش مصنوعی با **حافظه‌ی پایدار در Cloudflare D1**.
گفتگوها، پیام‌ها، زمان، شناسه و خلاصه‌ی حافظه در پایگاه‌داده ذخیره می‌شوند؛ با هر دستگاه
دیگری که با **همان حساب Cloudflare Access** وارد شوید، همان گفتگوها و همان فایل‌های کاری
را برمی‌دارید. `localStorage` فقط کشِ توکن GitHub و آخرین گفتگوی باز است.

> **صادقانه:** همگام‌سازی بین دستگاه‌ها تنها وقتی کار می‌کند که مراحل بخش
> [راه‌اندازی](#راه‌اندازی-دستی-در-cloudflare) واقعاً روی حساب Cloudflare شما انجام شده باشد.
> کد به‌تنهایی چیزی را همگام نمی‌کند.

## چه چیزی در این نسخه هست

| بخش | جزئیات |
| --- | --- |
| ورود امن | Cloudflare Access (RS256/JWKS) → کوکی نشست امضاشده با HMAC، `HttpOnly`, `SameSite=Strict`؛ یا حالت تک‌کاربره‌ی `DEV_ACCESS_EMAIL` |
| پایگاه‌داده | D1 با ۱۳ جدول: `users`, `conversations`, `messages`, `memories`, `workspace_files`, `file_versions`, `uploads`, `generated_images`, `usage_daily`, `rate_limits`, `meta` و… (مهاجرت خودکار تا `SCHEMA_VERSION 8`) |
| پیام‌ها | ترتیب پایدار با `seq`، ذخیره‌ی پیش از فراخوانی مدل، بازیابی گروه کامل `assistant/tool_calls/tool` |
| حافظه‌ی بلندمدت | خلاصه‌ی چرخشی گفتگو + ردیف‌های حافظه‌ی قابل‌ویرایش توسط کاربر |
| پنجره‌ی زمینه | بودجه‌ی توکن، برش فقط از مرز پیام کاربر، خلاصه‌سازی بخش‌های قدیمی |
| ابزارها | `think`, `list_files`, `read_file`, `search_code`, `list_symbols`, `apply_patch`, `write_file`, `delete_file`, `undo_edit`, `file_history`, `run_command`, `web_search`, `fetch_url`, `generate_image` |
| ویرایش دقیق | `apply_patch` با search/replace، تطبیق فازی فاصله‌ها، رد ویرایش مبهم، تولید diff سبک git |
| اعتبارسنجی | بررسی آکولاد/رشته/کامنت، تگ‌های HTML، JSON، و اسکن اعتبارنامه — قبل از بازگرداندن نتیجه |
| تاریخچه | نسخه‌ی هر فایل پیش از تغییر در D1، بازگردانی از UI یا با `undo_edit` |
| جست‌وجوی وب زنده | ابزار `web_search` چندمنبعی + `fetch_url` با محافظت کامل SSRF (loopback، RFC1918، cloud-metadata، ریدایرکت‌های re-validate شده) |
| استودیو تصویر | `generate_image` با **Cloudflare Workers AI** (FLUX.1 / Phoenix) بدون کلید خارجی؛ بهبود خودکار پرامپت فارسی، ذخیره‌ی chunk شده در D1، گالری owner-isolated |
| استخر درگاه مدل | تا **۱۰ درگاه** (tooken.club، OpenRouter، Zro، OpenAI-سازگار سفارشی) با failover خودکار و health-tracking به‌ازای هر کاربر؛ کلید API هر کاربر رمزنگاری‌شده در D1 ذخیره می‌شود |
| بهینه‌ساز توکن | حالت‌های `off/balanced/max/rpd`، کش سهمیه‌ی ارائه‌دهنده، کش کاتالوگ مدل‌ها |
| کشف Effort | کشف خودکار سطوح `reasoning_effort` مدل‌های تازه روی هر ارائه‌دهنده + کش در D1 |
| اجرا | سه حالت صادقانه: شل مجازی (پیش‌فرض)، سرور ابری `runner-kit`، پل مستقیم Termux روی `127.0.0.1:8787` |
| رازداری | پاک‌سازی کلید/توکن در پیام‌ها، حافظه، خروجی ابزار و پاسخ مدل؛ کلیدها فقط در Secrets |
| محدودیت مصرف | سقف درخواست در دقیقه/روز به‌ازای هر حساب (`rate_limits`) |
| آپلود | آپلود چانکی (هر قطعه ۱۹۲KB) + پیوست فایل/تصویر به پیام‌ها (تا ۲۰MB) |
| تست | ۹۰ تست بک‌اند (SQLite واقعی + Access جعلی) + تست دودی ۲۲۵-assertion رابط کاربری |
| UI | استریم SSE، ترمینال تعاملی، کاوشگر فایل، تنظیمات حافظه، خروجی JSON و حذف داده، ۳ تم، PWA فول‌اسکرین موبایل |
| توقف پاسخ | دکمه «⏹ توقف» هنگام تولید: `POST /api/chat/stop` استریم مدل را لغو می‌کند، متن جزئی ذخیره می‌شود و ادامه از همان نقطه ممکن است؛ حباب پاسخ نیمه‌کاره در UI هرگز پاک نمی‌شود |
| موتور قدرت | ۴ محور (استقامت، دقت جزئیات، پیشرفته‌سازی، حساسیت) + ۶ پروفایل یک‌کلیکی تا «اولترا کد»؛ سقف گام‌ها تا ۳۰۰ و بودجه زمینه تا ۲۵۶K با پارس ارقام فارسی |

## حالت ماراتن (کار مستمر)

حالت «ماراتن» به ایجنت اجازه می‌دهد بدون توقف و بدون پرسیدن سؤال، قدم‌به‌قدم تا فرمان «توقف» کاربر روی پروژه کار کند:

- **فعال‌سازی:** کارت «🚀 حالت ماراتن» در سایدبار ← انتخاب هدف و مدت ← «شروع».
- **انتقال:** نشان `marathon` در بدنه POST `/api/chat` ارسال می‌شود؛ `normalizeMarathon` آن را اعتبارسنجی می‌کند (سقف هدف ۶۰۰ کاراکتر، حداکثر ۲۴ ساعت، حداکثر ۱۲۰ چرخه) و `buildSystemPrompt` بخش «🚀 MARATHON MODE IS ACTIVE» را به سیستم‌پرامپت تزریق می‌کند.
- **مدت:** بی‌محدودیت یا ساعت/دقیقه‌ی دلخواه؛ در پایان بودجه، فرانت‌اند خودکار پیام توقف می‌فرستد.
- **توقف:** دکمه ⏹ یا ارسال پیام «توقف». پس از خاموش‌شدن، دیگر هیچ دستورالعملی تزریق نمی‌شود.
- **تست:** `tests/marathon.test.mjs` (نرمال‌سازی + تزریق پرامپت + بودجه‌های اجرایی) در `npm test` گنجانده شده است.

## ساختار پروژه

```
index.html                              رابط کاربری (فارسی، RTL، تک‌فایل: HTML+CSS+JS)
manifest.webmanifest                    مانیفست PWA (فول‌اسکرین موبایل)
schema.sql                              طرح D1 برای ساخت دستی (آینه‌ی SCHEMA_VERSION 8)
wrangler.toml                           اتصال D1 و AI و متغیرهای غیرحساس
scripts/check-deploy.sh                 تشخیص «کد قدیمی روی سایت» بعد از deploy
.dev.vars.example                       الگوی رازهای اجرای محلی
functions/api/auth.js                   GET/POST /api/auth
functions/api/config.js                 GET/POST /api/config (پیکربندی، provider، sandbox، agentConfig)
functions/api/health.js                 GET /api/health (تشخیص کانفیگ ناقص، بدون افشای راز)
functions/api/models.js                 GET/POST /api/models (کاتالوگ زنده + کشف Effort)
functions/api/chat.js                   POST /api/chat  (SSE، حلقه‌ی ابزار، ۱۴ ابزار)
functions/api/chat/stop.js              POST /api/chat/stop (توقف تولید فعال)
functions/api/run.js                    POST /api/run (اجرای ترمینال + probe سرور ابری)
functions/api/uploads.js                GET/POST /api/uploads (آپلود چانکی)
functions/api/images/index.js           GET/POST /api/images (فهرست + تولید تصویر)
functions/api/images/[id].js            GET/DELETE /api/images/:id (تصویر باینری + دانلود)
functions/api/state/index.js            GET/POST /api/state (bootstrap، export، delete، …)
functions/api/state/conversations/      فهرست سبک (index) و جزئیات کامل ([id])
functions/api/state/memory/index.js     GET/POST /api/state/memory
functions/api/state/usage.js            GET/POST /api/state/usage (مصرف + سقف توکن)
functions/api/state/search/index.js     جست‌وجوی سروری متن/regex
functions/api/state/versions/index.js   تاریخچه و بازگردانی نسخه‌ها
functions/_lib/auth.js                  Access + کوکی نشست
functions/_lib/schema.js                ساخت/مهاجرت خودکار D1
functions/_lib/store.js                 لایه‌ی داده (همه‌چیز scoped به owner)
functions/_lib/memory.js                پنجره‌ی زمینه، خلاصه‌سازی، repair گروه tool، سیستم‌پرامپت
functions/_lib/model.js                 تماس با ارائه‌دهنده‌ی مدل (کلید فقط در سرور، failover)
functions/_lib/provider.js              استخر درگاه، رمزنگاری کلید کاربر، نرمال‌سازی کانفیگ
functions/_lib/token-optimizer.js       بهینه‌ساز توکن ۴حالته
functions/_lib/patch.js                 اعمال search/replace + diff
functions/_lib/search.js                جست‌وجوی متن/regex و فهرست نمادها
functions/_lib/validate.js              اعتبارسنجی ساختاری + اسکن اعتبارنامه
functions/_lib/versions.js              تاریخچه‌ی نسخه‌ها در D1
functions/_lib/sandbox.js               اجرای واقعی/مجازی با fallback صادقانه
functions/_lib/web.js                   web_search + fetch_url با محافظت SSRF
functions/_lib/image.js                 استودیو تصویر Workers AI
functions/_lib/uploads.js               پروتکل آپلود چانکی
functions/_lib/attachments.js           پیوست‌های پیام (تا ۲۰MB)
functions/_lib/checkpoint.js            چک‌پوینت نوبت و ادامه از نقطه‌ی قطع
functions/_lib/turn-registry.js         رجیستری نوبت‌های فعال (برای stop)
functions/_lib/limits.js                محدودیت نرخ به‌ازای هر حساب
functions/_lib/api.js                   گارد مشترک: مبدأ، نشست، اسکیمای D1
functions/_lib/util.js                  Redaction، رمزنگاری، خطاها
runner-kit/                             سرور اجرای واقعی (Node صفر-وابستگی):
  server.mjs                              HF Spaces Docker (0.0.0.0:7860) یا Termux (127.0.0.1:8787)
  termux-setup.sh                         نصب‌گر Termux
tests/                                  تست‌های Node (SQLite واقعی + jsdom)
```

## «Access is not configured» — چه کنم؟

**اگر جمله انگلیسی است `Access is not configured.`** → کد قدیمی روی سایت است، یعنی
آخرین deploy شکست خورده (گام ۰).
**اگر فارسی است `access_unconfigured`** → کد جدید هست ولی تنظیمات ورود کامل نیست (گام ۱).

0. **اول مطمئن شوید کد جدید روی سایت است:**
   ```bash
   ./scripts/check-deploy.sh https://<سایت-شما>
   ```
   اگر گفت `STILL OLD CODE`، مشکل تنظیمات نیست — deploy شکست خورده است.

1. **دقیقاً ببینید چه کم است:**
   ```bash
   curl -s https://<سایت-شما>/api/health | jq
   ```
   خروجی نام هر متغیر/بایندینگ ناقص و راهنمای رفعش را می‌دهد (بدون افشای مقدار).

2. **ببینید مدل واقعاً جواب می‌دهد یا نه** (بعد از ورود):
   ```bash
   curl -s -b cookies.txt "https://<سایت-شما>/api/health?probe=1" | jq .probe
   ```
   یک درخواست کوچک به مدل می‌فرستد و کد خطای دقیق (`model_auth`، `model_not_found`،
   `model_rejected`، `model_unreachable`) را برمی‌گرداند — بدون مصرف محسوس توکن.
   در UI هم دکمه‌ی **⚡ تست اتصال مدل** در صفحه‌ی ورود همین کار را می‌کند.

3. **فعال‌سازی فوری بدون Zero Trust (تک‌کاربره):** `DEV_ACCESS_EMAIL` را ست کنید —
   دقیقاً یک متغیر. راهنما: `SETUP.md` بخش ۰. یک نوار هشدار در UI نشان می‌دهد که
   ورود واقعی نیست.

## راه‌اندازی دستی در Cloudflare

### ۱) ساخت پایگاه‌داده D1

```bash
npx wrangler login
npx wrangler d1 create codepilot-db
```

خروجی یک `database_id` می‌دهد. در این ریپو `wrangler.toml` با `pages_build_output_dir`
به‌صورت IaC تنظیم شده و `database_id` واقعی در آن هست؛ اگر ریپوی خودتان را می‌سازید،
مقدار را با uuid خودتان عوض کنید — **هرگز با مقدار placeholder کامیت نکنید.**

```bash
# اختیاری ولی توصیه‌شده: ساخت جدول‌ها به‌صورت صریح (آینه‌ی schema.js)
npx wrangler d1 execute codepilot-db --remote --file=./schema.sql
```

> برنامه خودش هم در اولین درخواست، جدول‌های لازم را می‌سازد و ستون‌های نسخه‌های قدیمی
> را اضافه می‌کند (`functions/_lib/schema.js`). اجرای دستی فقط برای شفافیت و بازبینی است.

### ۲) اتصال D1 به پروژه‌ی Pages

اگر از داشبورد استفاده می‌کنید: **Workers & Pages → پروژه → Settings → Functions →
D1 database bindings → Add**: نام متغیر **`DB`** و همان دیتابیس `codepilot-db`.

> ### چرا این مهم است
>
> اگر `database_id` در `wrangler.toml` مقدار جعلی (`REPLACE_WITH_...`) داشته باشد،
> مرحله‌ی deploy در Cloudflare شکست می‌خورد. Cloudflare در این حالت **نسخه‌ی موفق
> قبلی را سرو می‌کند** و فقط یک علامت قرمز کوچک در داشبورد نشان می‌دهد. نتیجه:
> هرچه push کنید، سایت همان خطای قدیمی را نشان می‌دهد.
>
> **همیشه بعد از push، وضعیت deploy را چک کنید** — یا `./scripts/check-deploy.sh`.

### ۳) Secrets (نه متغیرهای عادی)

```bash
openssl rand -base64 32            # برای SESSION_SECRET

npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put MODEL_API_KEY
```

| نام | الزامی | توضیح |
| --- | --- | --- |
| `SESSION_SECRET` | ⚪ | حداقل ۳۲ کاراکتر تصادفی؛ امضای کوکی نشست. ست نشود؟ خودکار و امن از `MODEL_API_KEY` مشتق می‌شود |
| `MODEL_API_KEY` | ✅ | کلید ارائه‌دهنده‌ی مدل؛ فقط در سرور می‌ماند |
| `ACCESS_TEAM_DOMAIN` | ✅* | مثل `myteam.cloudflareaccess.com` (*در حالت Access واقعی) |
| `ACCESS_AUD` | ✅* | Audience Tag اپلیکیشن Access |
| `DEV_ACCESS_EMAIL` | — | ورود تک‌کاربره‌ی سریع بدون Zero Trust |
| `MODEL_NAME` | — | پیش‌فرض `claude-sonnet-5-5` |
| `MODEL_BASE_URL` | — | پیش‌فرض `https://tooken.club/v1` |
| `CONTEXT_BUDGET_TOKENS` | — | پیش‌فرض `24000` |
| `ACCESS_ALLOWED_EMAILS` | — | فهرست ایمیل‌های مجاز با کاما (اختیاری) |
| `CHAT_LIMIT_PER_MINUTE` | — | پیش‌فرض `30` |
| `CHAT_LIMIT_PER_DAY` | — | پیش‌فرض `1200` |

**همه‌ی این‌ها از داشبورد قابل تنظیم‌اند** — `wrangler.toml` عمداً هیچ `[vars]`ی ندارد.
مسیر: **Settings → Variables and Secrets → Add**. برای کلید و راز، نوع **Secret** و
برای بقیه **Text**.

### ۴) Cloudflare Access

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

- دامنه: دامنه‌ی Pages (`codepilot.pages.dev` و/یا دامنه‌ی شخصی)
- Policy: مثلاً فقط ایمیل خودتان (یا Google/GitHub login)
- از صفحه‌ی اپلیکیشن، **Application Audience (AUD) Tag** را بردارید و در `ACCESS_AUD` بگذارید
- **Team domain** را در `ACCESS_TEAM_DOMAIN` بگذارید

Access کل سایت را می‌پوشاند. بدون آن، همه‌ی `/api/*` با `401` پاسخ می‌دهند و UI صفحه‌ی
«ورود امن لازم است» نشان می‌دهد.

### ۵) اجرای واقعی کد (اختیاری)

- **سرور ابری ۲۴ ساعته رایگان:** پوشه‌ی `runner-kit/` را روی Hugging Face Spaces (SDK=Docker)
  آپلود کنید و Secret با نام `CP_TOKEN` بسازید؛ آدرس Space و توکن را در مودال «🐧 ترمینال /
  سندباکس» وارد کنید. راهنمای کامل: `runner-kit/README.md`.
- **پل مستقیم Termux (اندروید):** در همان مودال، «پل مستقیم Termux محلی» را انتخاب و دستور
  نصب ۱-کلیکی را در Termux اجرا کنید — مرورگر از `http://127.0.0.1:8787` مستقیم به گوشی
  وصل می‌شود. پروبِ موفق حالت را بلافاصله فعال و ذخیره می‌کند.

### ۶) توکن Commit به GitHub (اختیاری)

این توکن *هویت کاربر نیست*: فقط اجازه‌ی نوشتن روی یک مخزن است و در `localStorage` همان
مرورگر می‌ماند. یک **fine-grained token** با دسترسی `Contents: Read and write` فقط روی
همان مخزن بسازید. توکن هرگز به D1، حافظه یا مدل فرستاده نمی‌شود.

## اجرای محلی

```bash
npm install
cp .dev.vars.example .dev.vars   # سپس مقادیر را پر کنید
npm run dev                       # wrangler pages dev . --d1 DB=codepilot-db
```

## تست‌ها

```bash
npm test         # ۹۰ تست: auth، CRUD، حافظه، خلاصه‌سازی، ابزارها، patch، جست‌وجو، اعتبارسنجی، نسخه‌ها، sandbox، SSRF، ماراتن، بهینه‌ساز توکن
npm run test:ui  # تست دودی رابط کاربری در jsdom (۲۲۵ assertion: استریم SSE، رندر ابزار، سندباکس Termux، استخر درگاه، ماراتن UI)
npm run test:all
```

تست‌ها به `jsdom` نیاز دارند (`npm install`). پایگاه‌داده در تست‌ها SQLite واقعی است
(`node:sqlite`) و با یک شبیه‌ساز D1 اجرا می‌شود؛ Access هم با JWKS و JWT محلی شبیه‌سازی
می‌شود، بنابراین همان کد تولیدی اجرا می‌شود.

## قرارداد API

| مسیر | متد | کار |
| --- | --- | --- |
| `/api/auth` | GET/POST | هویت کاربر و صدور کوکی / خروج |
| `/api/config` | GET/POST | پیکربندی غیرحساس / ذخیره‌ی provider، sandbox، agentConfig |
| `/api/health` | GET | تشخیص کانفیگ + `?probe=1` تست زنده‌ی مدل |
| `/api/models` | GET/POST | کاتالوگ زنده‌ی مدل‌ها / کشف Effort یک مدل |
| `/api/chat` | POST | یک نوبت گفتگو، پاسخ `text/event-stream` |
| `/api/chat/stop` | POST | توقف تولید فعال (متن جزئی ذخیره می‌شود) |
| `/api/run` | POST | اجرای فرمان ترمینال + `action: 'probe'` سرور ابری |
| `/api/uploads` | GET/POST | پروتکل آپلود چانکی (`start`/بخش/`delete`) |
| `/api/images` | GET/POST | فهرست تصاویر / تولید تصویر Workers AI |
| `/api/images/:id` | GET/DELETE | تصویر باینری owner-isolated (+`?download=1`) / حذف |
| `/api/state` | GET | یک‌جا: کاربر، گفتگوها، حافظه، مصرف |
| `/api/state` | POST | `create`, `rename`, `flags`, `delete`, `append`, `replace-messages`, `workspace`, `compact`, `fork`, `memory-upsert`, `memory-delete`, `export`, `delete-all` |
| `/api/state/conversations` | GET | فهرست سبک گفتگوها |
| `/api/state/conversations/:id` | GET | گفتگو + پیام‌ها + خلاصه + workspace + checkpoint |
| `/api/state/memory` | GET/POST | فهرست/افزودن/حذف حافظه |
| `/api/state/usage` | GET/POST | مصرف روزانه + سقف توکن |
| `/api/state/search` | POST | جست‌وجوی متن/regex در workspace ذخیره‌شده |
| `/api/state/versions` | GET/POST | تاریخچه‌ی یک فایل / بازگردانی نسخه |

رویدادهای استریم: `status`, `tool`, `tool_result`, `assistant`, `stopped`, `done`, `error`.

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
7. **کلید مدل هرگز به مرورگر نمی‌رسد.** `/api/config` فقط نام مدل و بودجه را می‌دهد؛
   کلید سفارشی کاربر در D1 رمزنگاری‌شده نگه داشته می‌شود.
8. **ویرایش مبهم رد می‌شود.** اگر متن جست‌وجو بیش از یک جا پیدا شود، `apply_patch` خطا
   می‌دهد تا مدل مجبور شود زمینه‌ی یکنواتر بفرستد؛ این جلوی خرابی خاموش را می‌گیرد.
9. **هر تغییر قبل از اعمال snapshot می‌شود** و diff آن در پاسخ `done` می‌آید؛ UI آن را
   نمایش می‌دهد و در صورت اتصال GitHub همان فایل را Commit می‌کند.
10. **اجرای واقعی ادعا نمی‌شود.** بدون Sandbox، نتیجه‌ی `run_command` با صراحت می‌گوید
    «Virtual shell»؛ با Sandbox ناموجود هم می‌گوید «NOT real execution».
11. **پروب موفق Termux فوراً حالت را فعال می‌کند** — تا کاربر دکمه‌ی ذخیره را نزده باشد،
    ترمینال و `run_command` همین حالا به `127.0.0.1` روتر می‌شوند و انتخاب در سرور هم
    ذخیره می‌شود.

## محدودیت‌های شناخته‌شده

- بدون runner خارجی، شل **مجازی** است: `ls`, `cat`, `touch`, `echo >`, `rm` روی فایل‌های
  workspace. هیچ فرمان OS یا دسترسی شبکه‌ای اجرا نمی‌شود.
- Commit به GitHub از مرورگر انجام می‌شود (توکن آنجاست). اگر مرورگر بسته شود، فایل در D1
  ذخیره است و در نوبت بعدی/Commit بعدی منتقل می‌شود.
- سقف‌ها: ۲۰۰ فایل در workspace، ۸M کاراکتر workspace و ۹۰۰K کاراکتر در هر فایل،
  ۴۰۰۰ پیام در هر گفتگو، ۳۰۰ گفتگو در هر کاربر، ۳۰ درخواست در دقیقه و ۱۲۰۰ در روز
  برای هر حساب (قابل تنظیم).
- ویرایش هم‌زمان دو دستگاه روی یک فایل با «آخرین نوشتن برنده است» حل می‌شود؛ `revision`
  از نوشتن روی نسخه‌ی کهنه جلوگیری می‌کند اما merge خودکار وجود ندارد.
- اجرای Durable Object / CRDT در این گام نیست.

## نقشه‌ی گام‌های بعدی (پیشنهاد)

1. **ایندکس FTS5 در D1** برای جست‌وجوی نمادها بین فایل‌ها.
2. **تفکیک workspace از گفتگو** — پروژه‌ی مستقل تا گفتگوهای متعدد روی یک پروژه کار کنند.
3. **همگام‌سازی هم‌زمان** — Durable Object برای جلوگیری از تعارض دو دستگاه در یک لحظه.
4. **ویرایش تفاضلی در UI** — نمایش hunk-by-hunk قبل از پذیرش هر پچ.
