// GET /api/health — deployment diagnostics for the "Access is not configured"
// class of problems. Reports only *presence and shape* of configuration; it
// never returns secret values, and requires a signed-in session for the
// detailed part.
//
// Without a session it still answers, but limited to non-sensitive booleans,
// so you can debug a fresh deployment from a terminal:
//   curl -s https://<your-site>/api/health | jq

import { json, errorResponse } from '../_lib/util.js';
import { ensureSchema } from '../_lib/schema.js';
import { sandboxEnabled, linuxRunnerEnabled, realExecutionMode } from '../_lib/sandbox.js';
import { authenticate } from '../_lib/auth.js';
import { callModel, modelEndpoint } from '../_lib/model.js';
import { resolveEffectiveEnv } from '../_lib/provider.js';

const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const checks = {};

    const rawDomain = String(env.ACCESS_TEAM_DOMAIN || '').trim();
    const domain = rawDomain.replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    checks.ACCESS_TEAM_DOMAIN = !rawDomain
      ? { ok: false, hint: 'تنظیم نشده. مقدار باید مثل myteam.cloudflareaccess.com باشد.' }
      : TEAM_DOMAIN.test(domain)
        ? { ok: true }
        : {
            ok: false,
            hint: 'قالب نامعتبر. باید دقیقاً <team>.cloudflareaccess.com باشد (بدون https و بدون /).'
          };

    checks.ACCESS_AUD = env.ACCESS_AUD
      ? { ok: true }
      : { ok: false, hint: 'تنظیم نشده. Application Audience (AUD) Tag را از اپلیکیشن Access بردارید.' };

    const secret = String(env.SESSION_SECRET || '').trim();
    checks.SESSION_SECRET =
      secret.length >= 32
        ? { ok: true }
        : secret.length > 0
          ? { ok: false, hint: `کوتاه است (${secret.length} کاراکتر). حداقل ۳۲ لازم است.` }
          : String(env.MODEL_API_KEY || '').trim()
            ? { ok: true, derived: true }
            : { ok: false, hint: 'تنظیم نشده. با openssl rand -base64 32 بسازید یا MODEL_API_KEY را تنظیم کنید.' };

    checks.MODEL_API_KEY = env.MODEL_API_KEY
      ? { ok: true }
      : { ok: false, hint: 'تنظیم نشده. کلید ارائه‌دهنده‌ی مدل را به‌صورت Secret اضافه کنید.' };

    checks.DB = env.DB ? { ok: true } : { ok: false, hint: 'بایندینگ D1 با نام DB وجود ندارد.' };

    if (env.DB) {
      try {
        await ensureSchema(env);
        checks.schema = { ok: true };
      } catch (error) {
        checks.schema = { ok: false, hint: `ساخت/مهاجرت جدول‌ها شکست خورد: ${error.message}` };
      }
    }

    const fallbackEmail = String(env.DEV_ACCESS_EMAIL || '').trim();
    const authMode =
      TEAM_DOMAIN.test(domain) && env.ACCESS_AUD
        ? 'cloudflare-access'
        : fallbackEmail
          ? 'dev-fallback'
          : 'unconfigured';
    if (fallbackEmail && (domain || env.ACCESS_AUD)) {
      checks.DEV_ACCESS_EMAIL = {
        ok: false,
        hint: 'هم‌زمان با ACCESS_TEAM_DOMAIN/ACCESS_AUD تنظیم شده است؛ یکی را بردارید.'
      };
    }

    const missing = Object.keys(checks).filter((key) => checks[key].ok === false);

    // `?probe=1` performs one tiny real completion so the operator can tell a
    // configuration problem from a provider problem. It requires a session, so
    // it cannot be used to burn someone's quota anonymously.
    let probe = null;
    if (url.searchParams.get('probe') === '1') {
      let identity = null;
      try {
        const authRes = await authenticate(request, env);
        identity = authRes?.identity || null;
      } catch {
        identity = null;
      }
      if (!identity) {
        probe = { ok: false, error: 'برای تست مدل باید وارد شده باشید.' };
      } else {
        const probeEnv = await resolveEffectiveEnv(env, identity.owner);
        if (!probeEnv.MODEL_API_KEY) {
          probe = { ok: false, error: 'MODEL_API_KEY تنظیم نشده است.' };
        } else {
          const started = Date.now();
          try {
            const requestedProbeModel = url.searchParams.get('model') || undefined;
            const reply = await callModel(probeEnv, {
              ...(requestedProbeModel ? { model: requestedProbeModel } : {}),
              messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
              max_tokens: 8,
              temperature: 0
            });
            probe = {
              ok: true,
              endpoint: modelEndpoint(probeEnv),
              model: reply.model,
              latencyMs: Date.now() - started,
              sample: String(reply.message?.content || '').slice(0, 40)
            };
          } catch (error) {
            probe = {
              ok: false,
              endpoint: modelEndpoint(probeEnv),
              code: error?.code || 'probe_failed',
              error: error?.message || 'تست مدل شکست خورد.',
              latencyMs: Date.now() - started
            };
          }
        }
      }
    }

    return json(
      {
        // `ok` means "this deployment can serve requests". Single-tenant mode is
        // a valid state (it only downgrades login), so it must not flip ok=false.
        ok:
          Boolean(checks.DB?.ok) &&
          (authMode === 'dev-fallback' || missing.length === 0) &&
          (!probe || probe.ok),
        authMode,
        sandbox: sandboxEnabled(env),
        linuxRunner: linuxRunnerEnabled(env),
        executionMode: realExecutionMode(env),
        model: String(env.MODEL_NAME || 'claude-sonnet-5-5'),
        checks,
        // In single-tenant mode, missing Access vars are expected, not failures.
        missing: authMode === 'dev-fallback' ? missing.filter((key) => !key.startsWith('ACCESS_')) : missing,
        modeWarning:
          authMode === 'dev-fallback'
            ? 'حالت تک‌کاربره: بدون ورود واقعی. هر کسی که آدرس سایت را بداند به گفتگوها دسترسی دارد.'
            : null,
        nextSteps: buildSteps(checks, authMode),
        ...(probe ? { probe } : {})
      },
      // 503 means "this deployment cannot serve": no DB, no auth mode, or a
      // broken setting in Access mode. Single-tenant mode alone stays 200.
      !checks.DB?.ok || authMode === 'unconfigured' || (authMode === 'cloudflare-access' && missing.length)
        ? 503
        : 200
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function buildSteps(checks, authMode) {
  const steps = [];
  if (!checks.DB?.ok) steps.push('npx wrangler d1 create codepilot-db سپس بایندینگ DB را در Pages اضافه کنید');
  if (!checks.SESSION_SECRET?.ok) steps.push('npx wrangler pages secret put SESSION_SECRET');
  if (!checks.MODEL_API_KEY?.ok) steps.push('npx wrangler pages secret put MODEL_API_KEY');
  if (!checks.ACCESS_TEAM_DOMAIN?.ok || !checks.ACCESS_AUD?.ok) {
    steps.push('Zero Trust → Access → Self-hosted app برای دامنه‌ی Pages بسازید، سپس ACCESS_TEAM_DOMAIN و ACCESS_AUD را ست کنید');
    steps.push('یا برای فعال‌سازی فوری و تک‌کاربره: DEV_ACCESS_EMAIL=you@example.com را به‌عنوان متغیر اضافه کنید');
  }
  if (authMode === 'dev-fallback') {
    steps.push('⚠ حالت تک‌کاربره فعال است: هر کسی با آدرس سایت به داده‌ها دسترسی دارد. Access را کامل کنید.');
  }
  return steps;
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return json({ error: 'متد پشتیبانی نمی‌شود.' }, 405, { Allow: 'GET' });
}
