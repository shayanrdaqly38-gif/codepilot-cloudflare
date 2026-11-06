// Per-user custom API provider settings (encrypted at rest in D1 `users.settings`)
// and persistent per-provider model capability discovery cache (in D1 `meta`).

import { ensureSchema } from './schema.js';
import { fail, sha256Hex, toHex } from './util.js';
import { assertSafeExternalUrl } from './web.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MODEL_ID_RE = /^[a-zA-Z0-9._:/-]{1,120}$/;
const MAX_CACHED_MODELS_PER_PROVIDER = 300;
const DISCOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function hexToBytes(hex) {
  const clean = String(hex || '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveAesKey(env) {
  const material = `cp-provider-aes-v1:${env.SESSION_SECRET || ''}:${env.MODEL_API_KEY || ''}:${env.ACCESS_AUD || 'dev'}`;
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptApiKey(env, plainKey) {
  const key = await deriveAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(String(plainKey)));
  return `v1:${toHex(iv)}:${toHex(new Uint8Array(cipher))}`;
}

export async function decryptApiKey(env, packed) {
  if (!packed || typeof packed !== 'string' || !packed.startsWith('v1:')) return '';
  const [, ivHex, cipherHex] = packed.split(':');
  const iv = hexToBytes(ivHex);
  const cipher = hexToBytes(cipherHex);
  if (!iv || !cipher) return '';
  try {
    const key = await deriveAesKey(env);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return decoder.decode(plain);
  } catch {
    return '';
  }
}

export function maskApiKey(rawKey) {
  const s = String(rawKey || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/**
 * Validate and normalize an OpenAI-compatible provider base URL (e.g.
 * `https://tooken.club/v1`, `https://openrouter.ai/api/v1`, `https://api.openai.com/v1`).
 * Blocks SSRF targets (localhost, RFC1918, cloud metadata).
 */
export function normalizeProviderBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  assertSafeExternalUrl(trimmed);
  return trimmed
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
}

export function effectiveBaseUrlFromEnv(env) {
  return String(env?.MODEL_BASE_URL || 'https://tooken.club/v1')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
}

export function isTookenUrl(baseUrl) {
  return /(?:^|\/\/|\.)tooken\.club(?:\/|$|:)/i.test(String(baseUrl || ''));
}

async function readUserSettingsObj(env, owner) {
  if (!env?.DB || !owner) return {};
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT settings FROM users WHERE owner=?').bind(owner).first();
  if (!row?.settings) return {};
  try {
    const parsed = JSON.parse(row.settings);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUserSettingsObj(env, owner, settingsObj) {
  if (!env?.DB || !owner) return;
  await ensureSchema(env);
  await env.DB.prepare('UPDATE users SET settings=? WHERE owner=?')
    .bind(JSON.stringify(settingsObj || {}), owner)
    .run();
}

/**
 * Return safe, non-secret provider metadata for the UI.
 */
export async function getUserProviderSummary(env, owner) {
  const settings = await readUserSettingsObj(env, owner);
  const p = settings.provider && typeof settings.provider === 'object' ? settings.provider : null;
  const serverBaseUrl = effectiveBaseUrlFromEnv(env);
  const hasServerKey = Boolean(env?.MODEL_API_KEY);
  const customBaseUrl = p?.baseUrl ? String(p.baseUrl) : '';
  const hasCustomKey = Boolean(p?.apiKeyEnc);
  const customDefaultModel = p?.defaultModel ? String(p.defaultModel) : '';
  const customActive = Boolean(customBaseUrl || hasCustomKey || customDefaultModel);

  return {
    customActive,
    baseUrl: customBaseUrl,
    effectiveBaseUrl: customBaseUrl || serverBaseUrl,
    serverBaseUrl,
    hasCustomKey,
    keyHint: p?.keyHint ? String(p.keyHint) : '',
    hasServerKey,
    defaultModel: customDefaultModel,
    effectiveDefaultModel: customDefaultModel || String(env?.MODEL_NAME || 'claude-sonnet-5-5')
  };
}

/**
 * Save or reset the user's custom OpenAI-compatible API provider configuration.
 */
export async function saveUserProviderConfig(env, owner, input = {}) {
  const settings = await readUserSettingsObj(env, owner);
  if (input.reset) {
    delete settings.provider;
    await writeUserSettingsObj(env, owner, settings);
    return getUserProviderSummary(env, owner);
  }

  const prev = settings.provider && typeof settings.provider === 'object' ? settings.provider : {};
  const nextBaseUrl =
    input.baseUrl !== undefined ? normalizeProviderBaseUrl(input.baseUrl) : String(prev.baseUrl || '');

  let apiKeyEnc = prev.apiKeyEnc || '';
  let keyHint = prev.keyHint || '';
  if (input.clearKey) {
    apiKeyEnc = '';
    keyHint = '';
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const cleanKey = input.apiKey.trim();
    if (cleanKey.length > 512 || /\s/.test(cleanKey)) {
      fail('قالب کلید API معتبر نیست.', 400, 'bad_api_key');
    }
    apiKeyEnc = await encryptApiKey(env, cleanKey);
    keyHint = maskApiKey(cleanKey);
  }

  let defaultModel = prev.defaultModel || '';
  if (input.defaultModel !== undefined) {
    const candidate = String(input.defaultModel || '').trim();
    if (candidate && !MODEL_ID_RE.test(candidate)) {
      fail('شناسه‌ی مدل پیش‌فرض معتبر نیست.', 400, 'bad_model');
    }
    defaultModel = candidate;
  }

  if (!nextBaseUrl && !apiKeyEnc && !defaultModel) {
    delete settings.provider;
  } else {
    settings.provider = {
      baseUrl: nextBaseUrl,
      apiKeyEnc,
      keyHint,
      defaultModel,
      updatedAt: Date.now()
    };
  }

  await writeUserSettingsObj(env, owner, settings);
  return getUserProviderSummary(env, owner);
}

/**
 * Build a request-scoped `env` overlay with the user's custom Base URL / API Key
 * (if configured), plus preloaded D1 discovered model capabilities for that Base URL.
 */
export async function resolveEffectiveEnv(env, owner) {
  if (!env?.DB || !owner) return env;
  const settings = await readUserSettingsObj(env, owner);
  const p = settings.provider && typeof settings.provider === 'object' ? settings.provider : null;

  let customKey = '';
  if (p?.apiKeyEnc) {
    customKey = await decryptApiKey(env, p.apiKeyEnc);
  }
  const customBaseUrl = p?.baseUrl ? String(p.baseUrl) : '';
  const customDefaultModel = p?.defaultModel ? String(p.defaultModel) : '';
  const hasCustom = Boolean(customBaseUrl || customKey || customDefaultModel);

  const effectiveBaseUrl = customBaseUrl || effectiveBaseUrlFromEnv(env);
  const discoveredMap = await loadDiscoveredSpecs(env, effectiveBaseUrl).catch(() => ({}));

  // If the user pointed at a non-tooken custom provider and didn't set a custom default model,
  // don't force `MODEL_FALLBACK` onto tooken-only model names.
  const isTooken = isTookenUrl(effectiveBaseUrl);

  return {
    ...env,
    MODEL_BASE_URL: effectiveBaseUrl,
    MODEL_API_KEY: customKey || env.MODEL_API_KEY || '',
    MODEL_NAME: customDefaultModel || (isTooken ? env.MODEL_NAME : '') || env.MODEL_NAME || 'claude-sonnet-5-5',
    MODEL_FALLBACK: !isTooken && customBaseUrl ? 'off' : env.MODEL_FALLBACK,
    _customProvider: hasCustom,
    _discoveredSpecs: discoveredMap
  };
}

/* ---------------- Persistent Per-Provider Capability Discovery Cache ---------------- */

async function capsMetaKey(baseUrl) {
  const norm = effectiveBaseUrlFromEnv({ MODEL_BASE_URL: baseUrl }).toLowerCase();
  const hash = await sha256Hex(norm);
  return `mcaps:${hash.slice(0, 20)}`;
}

export async function loadDiscoveredSpecs(env, baseUrl) {
  if (!env?.DB) return {};
  await ensureSchema(env);
  const key = await capsMetaKey(baseUrl);
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    const fresh = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === 'object' && (!entry.at || now - entry.at < DISCOVERY_TTL_MS)) {
        fresh[id] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

export async function saveDiscoveredSpec(env, baseUrl, modelId, spec) {
  if (!env?.DB || !modelId || !MODEL_ID_RE.test(modelId)) return;
  await ensureSchema(env);
  const key = await capsMetaKey(baseUrl);
  const current = await loadDiscoveredSpecs(env, baseUrl).catch(() => ({}));
  current[modelId] = {
    supported: Boolean(spec.supported && spec.levels?.length),
    levels: Array.isArray(spec.levels) ? spec.levels : [],
    unconfirmed: Boolean(spec.unconfirmed),
    via: String(spec.via || 'probed'),
    at: Date.now()
  };

  // Bound map size so `meta.value` stays small even across hundreds of models.
  const entries = Object.entries(current);
  if (entries.length > MAX_CACHED_MODELS_PER_PROVIDER) {
    entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    entries.length = MAX_CACHED_MODELS_PER_PROVIDER;
  }
  const compact = Object.fromEntries(entries);

  await env.DB.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  )
    .bind(key, JSON.stringify(compact))
    .run();
}
