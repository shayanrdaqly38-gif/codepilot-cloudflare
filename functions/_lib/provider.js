// Per-user custom API provider settings (encrypted at rest in D1 `users.settings`)
// and persistent per-provider model capability discovery cache (in D1 `meta`).

import { ensureSchema } from './schema.js';
import { fail, sha256Hex, toHex } from './util.js';
import { assertSafeExternalUrl } from './web.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MODEL_ID_RE = /^[a-zA-Z0-9._:@/-]{1,160}$/;
const INVISIBLE_MARKS_RE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const MAX_CACHED_MODELS_PER_PROVIDER = 300;
const DISCOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MODEL_LIST_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function cleanCredentialInput(value) {
  let s = String(value || '').replace(INVISIBLE_MARKS_RE, '').trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith('`') && s.endsWith('`')))
  ) {
    s = s.slice(1, -1).replace(INVISIBLE_MARKS_RE, '').trim();
  }
  return s;
}

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

export function isTookenUrl(baseUrl) {
  return /(?:^|\/\/|\.)tooken\.club(?:\/|$|:)/i.test(String(baseUrl || ''));
}

export function isOpenRouterUrl(baseUrl) {
  return /(?:^|\/\/|\.)openrouter\.ai(?:\/|$|:)/i.test(String(baseUrl || ''));
}

/**
 * Validate and normalize an OpenAI-compatible provider base URL (e.g.
 * `https://tooken.club/v1`, `https://openrouter.ai/api/v1`, `https://api.openai.com/v1`).
 * Blocks SSRF targets (localhost, RFC1918, cloud metadata) and normalizes common URL typos.
 */
export function normalizeProviderBaseUrl(rawUrl) {
  let trimmed = cleanCredentialInput(rawUrl);
  if (!trimmed) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  const parsed = assertSafeExternalUrl(trimmed);
  let normalized = `${parsed.origin}${parsed.pathname}`
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/(?:credits|key|balance|usage)$/i, '')
    .replace(/\/+$/, '');

  if (isOpenRouterUrl(normalized)) {
    try {
      const u = new URL(normalized);
      const p = u.pathname.replace(/\/+$/, '');
      if (!p || p === '/v1' || p === '/api') {
        normalized = `${u.origin}/api/v1`;
      }
    } catch { /* keep normalized */ }
  }
  return normalized;
}

export function effectiveBaseUrlFromEnv(env) {
  const raw = cleanCredentialInput(env?.MODEL_BASE_URL || 'https://tooken.club/v1')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
  if (isOpenRouterUrl(raw)) {
    try {
      const u = new URL(raw);
      const p = u.pathname.replace(/\/+$/, '');
      if (!p || p === '/v1' || p === '/api') return `${u.origin}/api/v1`;
    } catch { /* ignore */ }
  }
  return raw;
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
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users(owner, email, created_at, last_seen_at, settings)
     VALUES(?, '', ?, ?, ?)
     ON CONFLICT(owner) DO UPDATE SET settings=excluded.settings`
  )
    .bind(owner, now, now, JSON.stringify(settingsObj || {}))
    .run();
}

export function parseApiKeyPool(rawInput) {
  if (typeof rawInput !== 'string') return [];
  const parts = rawInput
    .split(/[\r\n,|]+/)
    .map((item) => cleanCredentialInput(item).replace(/^bearer\s+/i, '').trim())
    .filter(Boolean);
  const unique = [];
  for (const key of parts) {
    if (key.length > 2048 || /\s/.test(key)) {
      fail('قالب کلید API معتبر نیست (فاصله اضافی را حذف کنید؛ برای چند کلید چرخشی با کاما یا خط جدید جدا کنید).', 400, 'bad_api_key');
    }
    if (!unique.includes(key)) unique.push(key);
  }
  return unique.slice(0, 12);
}

export const MAX_PROVIDER_GATEWAYS = 10;
const MAX_FALLBACK_GATEWAYS = MAX_PROVIDER_GATEWAYS - 1;
const gatewayHealthMem = new Map();

export function gatewayHealthId(slot, baseUrl, customId = '') {
  const cleanId = String(customId || '').trim();
  const normUrl = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  return `${cleanId || `gw-${slot}`}::${normUrl}`;
}

async function gatewayHealthMetaKey(owner) {
  const hash = await sha256Hex(`gw-health:${String(owner || 'anon')}`);
  return `gwh:${hash.slice(0, 20)}`;
}

export async function loadGatewayHealthMap(env, owner) {
  if (!owner) return {};
  const now = Date.now();
  const mem = gatewayHealthMem.get(owner);
  if (mem && now - mem.loadedAt < 30_000) {
    return mem.entries || {};
  }
  if (!env?.DB) return mem?.entries || {};
  try {
    await ensureSchema(env);
    const key = await gatewayHealthMetaKey(owner);
    const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
    if (!row?.value) {
      gatewayHealthMem.set(owner, { loadedAt: now, entries: {} });
      return {};
    }
    const parsed = JSON.parse(row.value);
    const rawEntries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const pruned = {};
    for (const [k, v] of Object.entries(rawEntries)) {
      if (!v || typeof v !== 'object') continue;
      // Keep recent records (within 6 hours)
      const refTs = Math.max(Number(v.updatedAt) || 0, Number(v.cooldownUntil) || 0, Number(v.lastOkAt) || 0);
      if (refTs > 0 && now - refTs < 6 * 60 * 60 * 1000) {
        pruned[k] = v;
      }
    }
    gatewayHealthMem.set(owner, { loadedAt: now, entries: pruned });
    return pruned;
  } catch {
    return mem?.entries || {};
  }
}

export async function clearGatewayHealth(env, owner) {
  if (!owner) return;
  gatewayHealthMem.set(owner, { loadedAt: Date.now(), entries: {} });
  if (!env?.DB) return;
  try {
    await ensureSchema(env);
    const key = await gatewayHealthMetaKey(owner);
    await env.DB.prepare('DELETE FROM meta WHERE key=?').bind(key).run();
  } catch {
    // Non-fatal
  }
}

export async function recordGatewayOutcome(env, owner, gw, outcome = {}) {
  if (!owner || !gw?.baseUrl) return;
  const now = Date.now();
  const current = { ...(await loadGatewayHealthMap(env, owner)) };
  const hKey = gatewayHealthId(gw.slot || 1, gw.baseUrl, gw.id);
  const prev = current[hKey] && typeof current[hKey] === 'object' ? current[hKey] : {};

  if (outcome.ok) {
    current[hKey] = {
      slot: gw.slot || 1,
      baseUrl: gw.baseUrl,
      cooldownUntil: 0,
      failCount: 0,
      lastErrorCode: '',
      lastStatus: 200,
      lastOkAt: now,
      updatedAt: now
    };
  } else {
    const status = Number(outcome.status) || 0;
    const code = String(outcome.code || '');
    const failCount = (Number(prev.failCount) || 0) + 1;
    let cooldownMs = 75_000; // Default 75s cooldown for transient 429 / 5xx / timeout
    if (outcome.isDailyQuota || status === 402 || code === 'model_quota_exhausted') {
      cooldownMs = 20 * 60 * 1000; // 20 minutes for daily 50-RPD cap / depleted credits
    } else if (status === 401 || status === 403 || code === 'model_auth') {
      cooldownMs = 15 * 60 * 1000; // 15 minutes for invalid/revoked key
    } else if (failCount >= 3) {
      cooldownMs = Math.min(10 * 60 * 1000, 75_000 * failCount);
    }
    current[hKey] = {
      slot: gw.slot || 1,
      baseUrl: gw.baseUrl,
      cooldownUntil: now + cooldownMs,
      failCount,
      lastErrorCode: outcome.isDailyQuota ? 'daily_quota' : (code || `http_${status || 'err'}`),
      lastStatus: status,
      lastOkAt: Number(prev.lastOkAt) || 0,
      updatedAt: now
    };
  }

  gatewayHealthMem.set(owner, { loadedAt: now, entries: current });
  if (env && typeof env === 'object') {
    env._gatewayHealth = current;
  }
  if (!env?.DB) return;
  try {
    await ensureSchema(env);
    const key = await gatewayHealthMetaKey(owner);
    await env.DB.prepare(
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
      .bind(key, JSON.stringify(current))
      .run();
  } catch {
    // Non-fatal health persistence
  }
}

function normalizeStoredFallbacks(p) {
  if (!p || typeof p !== 'object') return [];
  const rawList = Array.isArray(p.fallbacks) ? p.fallbacks : [];
  const normalized = [];
  for (let i = 0; i < rawList.length && normalized.length < MAX_FALLBACK_GATEWAYS; i += 1) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;
    const baseUrl = item.baseUrl ? String(item.baseUrl) : '';
    const apiKeyEnc = item.apiKeyEnc ? String(item.apiKeyEnc) : '';
    const defaultModel = item.defaultModel ? String(item.defaultModel) : '';
    if (!baseUrl && !apiKeyEnc && !defaultModel) continue;
    const slot = normalized.length + 2;
    normalized.push({
      id: item.id ? String(item.id).slice(0, 40) : `gw-${slot}`,
      label: item.label ? String(item.label).slice(0, 60) : '',
      baseUrl,
      apiKeyEnc,
      keyHint: item.keyHint ? String(item.keyHint) : '',
      keyCount: Number(item.keyCount) || (apiKeyEnc ? 1 : 0),
      defaultModel,
      enabled: item.enabled !== false
    });
  }
  if (!normalized.length && (p.fallbackBaseUrl || p.fallbackApiKeyEnc || p.fallbackModel)) {
    normalized.push({
      id: 'gw-2',
      label: '',
      baseUrl: p.fallbackBaseUrl ? String(p.fallbackBaseUrl) : '',
      apiKeyEnc: p.fallbackApiKeyEnc ? String(p.fallbackApiKeyEnc) : '',
      keyHint: p.fallbackKeyHint ? String(p.fallbackKeyHint) : '',
      keyCount: p.fallbackApiKeyEnc ? 1 : 0,
      defaultModel: p.fallbackModel ? String(p.fallbackModel) : '',
      enabled: true
    });
  }
  return normalized;
}

/**
 * Return safe, non-secret provider metadata for the UI (supports up to 10 gateways: درگاه ۱ تا ۱۰).
 */
export async function getUserProviderSummary(env, owner) {
  const [settings, healthMap] = await Promise.all([
    readUserSettingsObj(env, owner),
    loadGatewayHealthMap(env, owner)
  ]);
  const now = Date.now();
  const p = settings.provider && typeof settings.provider === 'object' ? settings.provider : null;
  const serverBaseUrl = effectiveBaseUrlFromEnv(env);
  const hasServerKey = Boolean(env?.MODEL_API_KEY);
  const customBaseUrl = p?.baseUrl ? String(p.baseUrl) : '';
  const hasCustomKey = Boolean(p?.apiKeyEnc);
  const customDefaultModel = p?.defaultModel ? String(p.defaultModel) : '';

  const storedFallbacks = normalizeStoredFallbacks(p);
  const fallbackSummaries = storedFallbacks.map((fb, idx) => {
    const slot = idx + 2;
    const hasKey = Boolean(fb.apiKeyEnc);
    const active = Boolean(fb.enabled !== false && fb.baseUrl && hasKey);
    const hEntry = healthMap[gatewayHealthId(slot, fb.baseUrl, fb.id)] || null;
    const cooldownUntil = Number(hEntry?.cooldownUntil) || 0;
    const onCooldown = cooldownUntil > now;
    return {
      id: fb.id || `gw-${slot}`,
      slot,
      label: fb.label || '',
      baseUrl: fb.baseUrl,
      hasKey,
      keyHint: fb.keyHint || '',
      keyCount: Number(fb.keyCount) || (hasKey ? 1 : 0),
      defaultModel: fb.defaultModel || '',
      enabled: fb.enabled !== false,
      active,
      healthy: active && !onCooldown,
      cooldownRemainingSec: onCooldown ? Math.ceil((cooldownUntil - now) / 1000) : 0,
      lastErrorCode: onCooldown ? String(hEntry?.lastErrorCode || '') : '',
      lastOkAt: Number(hEntry?.lastOkAt) || 0
    };
  });

  const firstActiveFb = fallbackSummaries.find((f) => f.active) || fallbackSummaries[0] || null;
  const fallbackBaseUrl = firstActiveFb?.baseUrl || '';
  const hasFallbackKey = Boolean(firstActiveFb?.hasKey);
  const fallbackModel = firstActiveFb?.defaultModel || '';
  const customActive = Boolean(customBaseUrl || hasCustomKey || customDefaultModel || fallbackSummaries.length > 0);
  const fallbackActive = fallbackSummaries.some((f) => f.active);

  const effectiveBase = customBaseUrl || serverBaseUrl;
  const fallbackDefModel = isOpenRouterUrl(effectiveBase)
    ? 'openrouter/auto'
    : String(env?.MODEL_NAME || 'claude-sonnet-5-5');

  const gw1HasKey = Boolean(hasCustomKey || hasServerKey);
  const gw1Active = Boolean(effectiveBase && gw1HasKey);
  const gw1Health = healthMap[gatewayHealthId(1, effectiveBase, 'gw-1')] || null;
  const gw1CooldownUntil = Number(gw1Health?.cooldownUntil) || 0;
  const gw1OnCooldown = gw1CooldownUntil > now;

  const gateways = [
    {
      id: 'gw-1',
      slot: 1,
      label: 'درگاه اصلی',
      baseUrl: customBaseUrl,
      effectiveBaseUrl: effectiveBase,
      hasKey: hasCustomKey,
      hasEffectiveKey: gw1HasKey,
      keyHint: p?.keyHint ? String(p.keyHint) : '',
      keyCount: Number(p?.keyCount) || (hasCustomKey ? 1 : 0),
      defaultModel: customDefaultModel,
      enabled: true,
      active: gw1Active,
      healthy: gw1Active && !gw1OnCooldown,
      cooldownRemainingSec: gw1OnCooldown ? Math.ceil((gw1CooldownUntil - now) / 1000) : 0,
      lastErrorCode: gw1OnCooldown ? String(gw1Health?.lastErrorCode || '') : '',
      lastOkAt: Number(gw1Health?.lastOkAt) || 0
    },
    ...fallbackSummaries
  ];

  const activeGateways = gateways.filter((g) => g.active);
  const workingGw = activeGateways.find((g) => g.healthy) || activeGateways[0] || gateways[0];

  return {
    customActive,
    usingCustom: customActive,
    baseUrl: customBaseUrl,
    effectiveBaseUrl: effectiveBase,
    serverBaseUrl,
    hasCustomKey,
    keyHint: p?.keyHint ? String(p.keyHint) : '',
    keyCount: Number(p?.keyCount) || (hasCustomKey ? 1 : 0),
    hasServerKey,
    defaultModel: customDefaultModel,
    effectiveDefaultModel: customDefaultModel || fallbackDefModel,
    fallbackActive,
    fallbackBaseUrl,
    hasFallbackKey,
    fallbackKeyHint: firstActiveFb?.keyHint || '',
    fallbackModel,
    maxGateways: MAX_PROVIDER_GATEWAYS,
    activeGatewayCount: activeGateways.length,
    workingGatewaySlot: workingGw?.slot || 1,
    workingBaseUrl: workingGw?.effectiveBaseUrl || workingGw?.baseUrl || effectiveBase,
    fallbacks: fallbackSummaries,
    gateways
  };
}

/**
 * Save or reset the user's custom OpenAI-compatible API provider configuration
 * (supports Primary Gateway #1 + up to 9 Backup Gateways #2..#10 = 10 Gateways total).
 */
export async function saveUserProviderConfig(env, owner, input = {}) {
  const settings = await readUserSettingsObj(env, owner);
  if (input.reset) {
    delete settings.provider;
    await writeUserSettingsObj(env, owner, settings);
    await clearGatewayHealth(env, owner);
    return getUserProviderSummary(env, owner);
  }

  const prev = settings.provider && typeof settings.provider === 'object' ? settings.provider : {};
  const prevFallbacks = normalizeStoredFallbacks(prev);

  // Optional unified `input.gateways` (slots 1..10) convenience support:
  let primaryInput = input;
  let fallbacksInput = input.fallbacks;
  if (Array.isArray(input.gateways)) {
    if (input.gateways.length > MAX_PROVIDER_GATEWAYS) {
      fail(`حداکثر ${MAX_PROVIDER_GATEWAYS} درگاه قابل ثبت است.`, 400, 'too_many_gateways');
    }
    const [gw1, ...restGws] = input.gateways;
    if (gw1 && typeof gw1 === 'object') {
      primaryInput = {
        ...input,
        baseUrl: gw1.baseUrl !== undefined ? gw1.baseUrl : input.baseUrl,
        apiKey: gw1.apiKey !== undefined ? gw1.apiKey : input.apiKey,
        clearKey: gw1.clearKey !== undefined ? gw1.clearKey : input.clearKey,
        defaultModel: gw1.defaultModel !== undefined ? gw1.defaultModel : input.defaultModel
      };
    }
    if (fallbacksInput === undefined) {
      fallbacksInput = restGws;
    }
  }

  const nextBaseUrl =
    primaryInput.baseUrl !== undefined ? normalizeProviderBaseUrl(primaryInput.baseUrl) : String(prev.baseUrl || '');

  let apiKeyEnc = prev.apiKeyEnc || '';
  let keyHint = prev.keyHint || '';
  let keyCount = Number(prev.keyCount) || (apiKeyEnc ? 1 : 0);
  if (primaryInput.clearKey) {
    apiKeyEnc = '';
    keyHint = '';
    keyCount = 0;
  } else if (typeof primaryInput.apiKey === 'string') {
    const pool = parseApiKeyPool(primaryInput.apiKey);
    if (pool.length) {
      apiKeyEnc = await encryptApiKey(env, pool.join('\n'));
      keyCount = pool.length;
      keyHint = pool.length > 1 ? `${maskApiKey(pool[0])} (+${pool.length - 1} کلید)` : maskApiKey(pool[0]);
    }
  }

  let defaultModel = prev.defaultModel || '';
  if (primaryInput.defaultModel !== undefined) {
    const candidate = cleanCredentialInput(primaryInput.defaultModel);
    if (candidate && !MODEL_ID_RE.test(candidate)) {
      fail('شناسه‌ی مدل پیش‌فرض معتبر نیست.', 400, 'bad_model');
    }
    defaultModel = candidate;
  }

  let nextFallbacks = [];
  if (Array.isArray(fallbacksInput)) {
    if (fallbacksInput.length > MAX_FALLBACK_GATEWAYS) {
      fail(`حداکثر ${MAX_PROVIDER_GATEWAYS} درگاه (۱ اصلی + ${MAX_FALLBACK_GATEWAYS} پشتیبان) قابل ثبت است.`, 400, 'too_many_gateways');
    }
    const prevById = new Map(prevFallbacks.map((item) => [item.id, item]));
    const usedPrevIds = new Set();

    for (let i = 0; i < fallbacksInput.length; i += 1) {
      const raw = fallbacksInput[i];
      if (!raw || typeof raw !== 'object') continue;
      const slotNum = nextFallbacks.length + 2;
      const normUrl = raw.baseUrl ? normalizeProviderBaseUrl(raw.baseUrl) : '';
      const normModel = raw.defaultModel !== undefined ? cleanCredentialInput(raw.defaultModel) : '';
      if (normModel && !MODEL_ID_RE.test(normModel)) {
        fail(`شناسه‌ی مدل در درگاه ${slotNum} معتبر نیست.`, 400, 'bad_model');
      }
      const normLabel = typeof raw.label === 'string' ? cleanCredentialInput(raw.label).slice(0, 60) : '';
      const rawId = typeof raw.id === 'string' ? cleanCredentialInput(raw.id).slice(0, 40) : '';
      let matchedPrev = rawId && prevById.has(rawId) && !usedPrevIds.has(rawId) ? prevById.get(rawId) : null;
      if (!matchedPrev && normUrl) {
        matchedPrev = prevFallbacks.find((pf) => !usedPrevIds.has(pf.id) && pf.baseUrl === normUrl) || null;
      }
      if (matchedPrev) usedPrevIds.add(matchedPrev.id);

      let fbKeyEnc = matchedPrev?.apiKeyEnc || '';
      let fbKeyHint = matchedPrev?.keyHint || '';
      let fbKeyCount = Number(matchedPrev?.keyCount) || (fbKeyEnc ? 1 : 0);

      if (raw.clearKey || (!normUrl && !raw.apiKey)) {
        fbKeyEnc = '';
        fbKeyHint = '';
        fbKeyCount = 0;
      } else if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
        const fbPool = parseApiKeyPool(raw.apiKey);
        if (fbPool.length) {
          fbKeyEnc = await encryptApiKey(env, fbPool.join('\n'));
          fbKeyCount = fbPool.length;
          fbKeyHint =
            fbPool.length > 1 ? `${maskApiKey(fbPool[0])} (+${fbPool.length - 1} کلید)` : maskApiKey(fbPool[0]);
        }
      }

      if (!normUrl && !fbKeyEnc && !normModel) continue;

      nextFallbacks.push({
        id: rawId || matchedPrev?.id || `gw-${slotNum}`,
        label: normLabel || matchedPrev?.label || '',
        baseUrl: normUrl,
        apiKeyEnc: fbKeyEnc,
        keyHint: fbKeyHint,
        keyCount: fbKeyCount,
        defaultModel: raw.defaultModel !== undefined ? normModel : (matchedPrev?.defaultModel || ''),
        enabled: raw.enabled !== false
      });
    }
  } else {
    // Legacy single-fallback compatibility (`fallbackBaseUrl`, `fallbackApiKey`, `clearFallbackKey`, `fallbackModel`)
    const touchesLegacyFallback =
      input.fallbackBaseUrl !== undefined ||
      input.fallbackApiKey !== undefined ||
      Boolean(input.clearFallbackKey) ||
      input.fallbackModel !== undefined;

    if (!touchesLegacyFallback) {
      nextFallbacks = prevFallbacks;
    } else {
      const prevFirst = prevFallbacks[0] || null;
      const fbUrl =
        input.fallbackBaseUrl !== undefined
          ? normalizeProviderBaseUrl(input.fallbackBaseUrl)
          : String(prevFirst?.baseUrl || '');

      let fbKeyEnc = prevFirst?.apiKeyEnc || '';
      let fbKeyHint = prevFirst?.keyHint || '';
      let fbKeyCount = Number(prevFirst?.keyCount) || (fbKeyEnc ? 1 : 0);
      if (input.clearFallbackKey || (input.fallbackBaseUrl !== undefined && !fbUrl && !input.fallbackApiKey)) {
        fbKeyEnc = '';
        fbKeyHint = '';
        fbKeyCount = 0;
      } else if (typeof input.fallbackApiKey === 'string') {
        const fbPool = parseApiKeyPool(input.fallbackApiKey);
        if (fbPool.length) {
          fbKeyEnc = await encryptApiKey(env, fbPool.join('\n'));
          fbKeyCount = fbPool.length;
          fbKeyHint =
            fbPool.length > 1 ? `${maskApiKey(fbPool[0])} (+${fbPool.length - 1} کلید)` : maskApiKey(fbPool[0]);
        }
      }

      let fbModel = prevFirst?.fallbackModel || prevFirst?.defaultModel || '';
      if (input.fallbackModel !== undefined) {
        const cleaned = cleanCredentialInput(input.fallbackModel);
        if (cleaned && !MODEL_ID_RE.test(cleaned)) {
          fail('شناسه‌ی مدل درگاه پشتیبان معتبر نیست.', 400, 'bad_model');
        }
        fbModel = cleaned;
      }

      const rest = prevFallbacks.slice(1);
      if (fbUrl || fbKeyEnc || fbModel) {
        nextFallbacks = [
          {
            id: prevFirst?.id || 'gw-2',
            label: prevFirst?.label || '',
            baseUrl: fbUrl,
            apiKeyEnc: fbKeyEnc,
            keyHint: fbKeyHint,
            keyCount: fbKeyCount,
            defaultModel: fbModel,
            enabled: true
          },
          ...rest
        ].slice(0, MAX_FALLBACK_GATEWAYS);
      } else {
        nextFallbacks = rest;
      }
    }
  }

  // Re-number sequential fallback IDs cleanly while preserving custom non-gw IDs
  nextFallbacks = nextFallbacks.slice(0, MAX_FALLBACK_GATEWAYS).map((fb, idx) => ({
    ...fb,
    id: fb.id && !/^gw-\d+$/.test(fb.id) ? fb.id : `gw-${idx + 2}`
  }));

  const firstFb = nextFallbacks[0] || null;

  if (!nextBaseUrl && !apiKeyEnc && !defaultModel && nextFallbacks.length === 0) {
    delete settings.provider;
  } else {
    settings.provider = {
      baseUrl: nextBaseUrl,
      apiKeyEnc,
      keyHint,
      keyCount,
      defaultModel,
      fallbacks: nextFallbacks,
      fallbackBaseUrl: firstFb?.baseUrl || '',
      fallbackApiKeyEnc: firstFb?.apiKeyEnc || '',
      fallbackKeyHint: firstFb?.keyHint || '',
      fallbackModel: firstFb?.defaultModel || '',
      updatedAt: Date.now()
    };
  }

  await writeUserSettingsObj(env, owner, settings);
  await clearGatewayHealth(env, owner);
  return getUserProviderSummary(env, owner);
}

export const VALID_AGENT_MODES = ['plan', 'suggest', 'auto-edit', 'full-auto'];
export const VALID_RESPONSE_STYLES = ['balanced', 'concise', 'explanatory', 'senior-reviewer'];
export const VALID_THEMES = ['claude-warm', 'claude-day', 'midnight'];
export const VALID_POWER_LEVELS = ['low', 'medium', 'hard', 'very-hard', 'max', 'ultra-code'];
export const VALID_SANDBOX_MODES = ['auto', 'cloud-url', 'local-termux'];
export const VALID_TOKEN_SAVER_MODES = ['off', 'balanced', 'max', 'rpd'];

/**
 * Validate and normalize a remote Cloud Runner URL (e.g. Hugging Face Spaces
 * `https://user-space.hf.space` or Cloudflare Tunnel `https://xxx.trycloudflare.com`).
 * Enforces SSRF protection so server-side Workers never fetch private/loopback IPs.
 */
export function normalizeSandboxUrl(rawUrl) {
  let trimmed = cleanCredentialInput(rawUrl);
  if (!trimmed) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  const parsed = assertSafeExternalUrl(trimmed);
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Validate a browser-local Termux loopback endpoint (`http://127.0.0.1:<port>` or `http://localhost:<port>`).
 * Strictly restricted to loopback HTTP so the browser never leaks workspace code to non-local hosts.
 */
export function normalizeLocalTermuxUrl(rawUrl) {
  const trimmed = cleanCredentialInput(rawUrl);
  if (!trimmed) return 'http://127.0.0.1:8787';
  let candidate = trimmed;
  if (/^\d{2,5}$/.test(candidate)) {
    candidate = `http://127.0.0.1:${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    fail('آدرس محلی Termux معتبر نیست (مثلاً http://127.0.0.1:8787).', 400, 'bad_local_termux_url');
  }
  if (parsed.protocol !== 'http:') {
    fail('پل محلی Termux باید از پروتکل http روی 127.0.0.1 یا localhost استفاده کند.', 400, 'bad_local_termux_url');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    fail('آدرس پل محلی Termux فقط می‌تواند 127.0.0.1 یا localhost باشد (برای آدرس‌های اینترنتی از حالت «سرور ابری ۲۴ ساعته» استفاده کنید).', 400, 'bad_local_termux_url');
  }
  const port = parsed.port ? Number(parsed.port) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('پورت Termux باید عددی بین ۱ تا ۶۵۵۳۵ باشد.', 400, 'bad_local_termux_port');
  }
  return `http://${host}:${port}`;
}

export async function getUserSandboxSummary(env, owner) {
  const settings = await readUserSettingsObj(env, owner);
  const s = settings.sandbox && typeof settings.sandbox === 'object' ? settings.sandbox : null;
  const mode = VALID_SANDBOX_MODES.includes(s?.mode) ? s.mode : 'auto';
  const cloudUrl = s?.cloudUrl ? String(s.cloudUrl) : '';
  const hasCloudToken = Boolean(s?.tokenEnc);
  const tokenHint = s?.tokenHint ? String(s.tokenHint) : '';
  const localUrl = s?.localUrl ? String(s.localUrl) : 'http://127.0.0.1:8787';
  const serverHasSandboxUrl = Boolean(env?.SANDBOX_URL);

  let effectiveMode = 'linux-container';
  if (mode === 'local-termux') effectiveMode = 'local-termux';
  else if (mode === 'cloud-url' && cloudUrl) effectiveMode = 'cloud-url';
  else if (serverHasSandboxUrl) effectiveMode = 'server-remote';

  return {
    mode,
    cloudUrl,
    hasCloudToken,
    tokenHint,
    localUrl,
    serverHasSandboxUrl,
    effectiveMode
  };
}

export async function saveUserSandboxConfig(env, owner, input = {}) {
  const settings = await readUserSettingsObj(env, owner);
  if (input.reset) {
    delete settings.sandbox;
    await writeUserSettingsObj(env, owner, settings);
    return getUserSandboxSummary(env, owner);
  }

  const prev = settings.sandbox && typeof settings.sandbox === 'object' ? settings.sandbox : {};
  const mode =
    input.mode !== undefined
      ? (VALID_SANDBOX_MODES.includes(input.mode) ? input.mode : 'auto')
      : (VALID_SANDBOX_MODES.includes(prev.mode) ? prev.mode : 'auto');

  const cloudUrl =
    input.cloudUrl !== undefined ? normalizeSandboxUrl(input.cloudUrl) : String(prev.cloudUrl || '');
  const localUrl =
    input.localUrl !== undefined
      ? normalizeLocalTermuxUrl(input.localUrl)
      : String(prev.localUrl || 'http://127.0.0.1:8787');

  if (mode === 'cloud-url' && !cloudUrl) {
    fail('لطفاً آدرس HTTPS سرور ابری (مثلاً لینک Hugging Face Space یا Cloudflare Tunnel) را وارد کنید.', 400, 'missing_sandbox_url');
  }

  let tokenEnc = prev.tokenEnc || '';
  let tokenHint = prev.tokenHint || '';
  if (input.clearToken) {
    tokenEnc = '';
    tokenHint = '';
  } else if (typeof input.cloudToken === 'string') {
    const cleaned = cleanCredentialInput(input.cloudToken).replace(/^bearer\s+/i, '').trim();
    if (cleaned) {
      if (cleaned.length > 1024 || /\s/.test(cleaned)) {
        fail('قالب توکن سندباکس معتبر نیست (فاصله را حذف کنید).', 400, 'bad_sandbox_token');
      }
      tokenEnc = await encryptApiKey(env, cleaned);
      tokenHint = maskApiKey(cleaned);
    }
  }

  if (mode === 'auto' && !cloudUrl && !tokenEnc && localUrl === 'http://127.0.0.1:8787') {
    delete settings.sandbox;
  } else {
    settings.sandbox = {
      mode,
      cloudUrl,
      tokenEnc,
      tokenHint,
      localUrl,
      updatedAt: Date.now()
    };
  }

  await writeUserSettingsObj(env, owner, settings);
  return getUserSandboxSummary(env, owner);
}

export const POWER_LEVEL_RANK = Object.freeze({
  low: 0,
  medium: 1,
  hard: 2,
  'very-hard': 3,
  max: 4,
  'ultra-code': 5
});

export const DEFAULT_AGENT_CONFIG = Object.freeze({
  mode: 'auto-edit',
  networkAccess: true,
  shellAccess: true,
  autoVerify: true,
  autoCommitGh: true,
  readAgentsMd: true,
  responseStyle: 'balanced',
  customInstructions: '',
  temperature: 0.25,
  maxSteps: 20,
  contextBudget: 24_000,
  workStamina: 'medium',
  detailThinking: 'medium',
  ambitionLevel: 'medium',
  humanSensitivity: 'medium',
  tokenSaver: 'max',
  theme: 'claude-warm',
  reducedMotion: false,
  mascot: true,
  goal: '',
  marathon: {
    active: false,
    paused: false,
    goal: '',
    durationH: 0,
    startedAt: null,
    maxCycles: 30,
    cycle: 0,
    conversationId: ''
  }
});

function normalizePowerLevel(val, fallback = 'medium') {
  return VALID_POWER_LEVELS.includes(val) ? val : fallback;
}

export function normalizeAgentConfig(raw = {}, base = DEFAULT_AGENT_CONFIG) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = VALID_AGENT_MODES.includes(src.mode) ? src.mode : base.mode;
  const responseStyle = VALID_RESPONSE_STYLES.includes(src.responseStyle) ? src.responseStyle : base.responseStyle;
  const theme = VALID_THEMES.includes(src.theme) ? src.theme : base.theme;
  const tempNum = Number(src.temperature);
  const temperature = Number.isFinite(tempNum) ? Math.min(1.5, Math.max(0, Math.round(tempNum * 100) / 100)) : base.temperature;
  const stepsNum = Math.floor(Number(src.maxSteps));
  const maxSteps = Number.isFinite(stepsNum) && stepsNum >= 4 && stepsNum <= 96 ? stepsNum : base.maxSteps;
  const budgetNum = Math.floor(Number(src.contextBudget));
  const contextBudget =
    Number.isFinite(budgetNum) && budgetNum >= 6_000 && budgetNum <= 160_000 ? budgetNum : base.contextBudget;

  return {
    mode,
    networkAccess: typeof src.networkAccess === 'boolean' ? src.networkAccess : base.networkAccess,
    shellAccess: typeof src.shellAccess === 'boolean' ? src.shellAccess : base.shellAccess,
    autoVerify: typeof src.autoVerify === 'boolean' ? src.autoVerify : base.autoVerify,
    autoCommitGh: typeof src.autoCommitGh === 'boolean' ? src.autoCommitGh : base.autoCommitGh,
    readAgentsMd: typeof src.readAgentsMd === 'boolean' ? src.readAgentsMd : base.readAgentsMd,
    responseStyle,
    customInstructions:
      typeof src.customInstructions === 'string'
        ? src.customInstructions.slice(0, 4_000)
        : base.customInstructions,
    temperature,
    maxSteps,
    contextBudget,
    workStamina: normalizePowerLevel(src.workStamina, base.workStamina || 'medium'),
    detailThinking: normalizePowerLevel(src.detailThinking, base.detailThinking || 'medium'),
    ambitionLevel: normalizePowerLevel(src.ambitionLevel, base.ambitionLevel || 'medium'),
    humanSensitivity: normalizePowerLevel(src.humanSensitivity, base.humanSensitivity || 'medium'),
    tokenSaver: VALID_TOKEN_SAVER_MODES.includes(src.tokenSaver) ? src.tokenSaver : (base.tokenSaver || 'max'),
    theme,
    reducedMotion: typeof src.reducedMotion === 'boolean' ? src.reducedMotion : base.reducedMotion,
    mascot: typeof src.mascot === 'boolean' ? src.mascot : base.mascot,
    goal: typeof src.goal === 'string' ? src.goal.slice(0, 600) : base.goal,
    marathon: normalizeMarathon(src.marathon, base.marathon)
  };
}

function normalizeMarathon(m, baseM = {}) {
  const src = m && typeof m === 'object' ? m : {};
  const b = baseM && typeof baseM === 'object' ? baseM : {};
  const durNum = Number(src.durationH);
  const maxCycNum = Math.floor(Number(src.maxCycles));
  const cycNum = Math.floor(Number(src.cycle));
  return {
    active: typeof src.active === 'boolean' ? src.active : !!b.active,
    paused: typeof src.paused === 'boolean' ? src.paused : !!b.paused,
    goal: typeof src.goal === 'string' ? src.goal.slice(0, 600).trim() : (b.goal || ''),
    durationH: Number.isFinite(durNum) ? Math.min(24, Math.max(0, Math.round(durNum * 100) / 100)) : (Number(b.durationH) || 0),
    startedAt:
      Number.isFinite(Number(src.startedAt)) && Number(src.startedAt) > 0
        ? Number(src.startedAt)
        : (b.startedAt || null),
    maxCycles:
      Number.isFinite(maxCycNum) && maxCycNum >= 1
        ? Math.min(120, maxCycNum)
        : (Number.isFinite(Number(b.maxCycles)) && Number(b.maxCycles) >= 1 ? Math.min(120, Math.floor(Number(b.maxCycles))) : 30),
    cycle:
      Number.isFinite(cycNum) && cycNum >= 0
        ? Math.min(999, cycNum)
        : (Number.isFinite(Number(b.cycle)) && Number(b.cycle) >= 0 ? Math.floor(Number(b.cycle)) : 0),
    conversationId:
      typeof src.conversationId === 'string'
        ? src.conversationId.slice(0, 64).trim()
        : (typeof b.conversationId === 'string' ? b.conversationId.slice(0, 64).trim() : '')
  };
}

/**
 * Translate the 4 independent AI Power Engine axes (`workStamina`, `detailThinking`,
 * `ambitionLevel`, `humanSensitivity`) + untouched `reasoningEffort` into concrete
 * execution budgets for the server-side autonomous loop.
 */
export function resolvePowerExecutionPlan(agentConfig = {}, reasoningEffort = null) {
  const cfg = normalizeAgentConfig(agentConfig, DEFAULT_AGENT_CONFIG);
  const stamina = cfg.workStamina || 'medium';
  const detail = cfg.detailThinking || 'medium';
  const ambition = cfg.ambitionLevel || 'medium';
  const sensitivity = cfg.humanSensitivity || 'medium';

  const STAMINA_SPECS = {
    low: { stepCap: 8, stepFloor: 6, maxFileEdits: 24, contextFloor: 16_000, maxTurnInputChars: 220_000, timeoutMs: 95_000 },
    medium: { stepCap: 36, stepFloor: 16, maxFileEdits: 72, contextFloor: 24_000, maxTurnInputChars: 260_000, timeoutMs: 120_000 },
    hard: { stepCap: 48, stepFloor: 32, maxFileEdits: 110, contextFloor: 36_000, maxTurnInputChars: 340_000, timeoutMs: 145_000 },
    'very-hard': { stepCap: 64, stepFloor: 44, maxFileEdits: 150, contextFloor: 48_000, maxTurnInputChars: 420_000, timeoutMs: 165_000 },
    max: { stepCap: 80, stepFloor: 60, maxFileEdits: 200, contextFloor: 64_000, maxTurnInputChars: 500_000, timeoutMs: 175_000 },
    'ultra-code': { stepCap: 96, stepFloor: 80, maxFileEdits: 260, contextFloor: 88_000, maxTurnInputChars: 600_000, timeoutMs: 180_000 }
  };
  const spec = STAMINA_SPECS[stamina] || STAMINA_SPECS.medium;

  let baseMaxSteps =
    cfg.mode === 'full-auto'
      ? Math.max(cfg.maxSteps || 24, 28)
      : reasoningEffort === 'max' || reasoningEffort === 'xhigh'
        ? Math.max(cfg.maxSteps || 20, 28)
        : reasoningEffort === 'high'
          ? Math.max(cfg.maxSteps || 20, 24)
          : cfg.maxSteps || 20;

  let maxSteps;
  if (stamina === 'low') {
    maxSteps = Math.min(baseMaxSteps, spec.stepCap);
  } else if (stamina === 'medium') {
    maxSteps = Math.min(Math.max(baseMaxSteps, 4), spec.stepCap);
  } else {
    maxSteps = Math.min(Math.max(baseMaxSteps, spec.stepFloor), spec.stepCap);
  }

  const marathonActive = Boolean(cfg.marathon?.active && !cfg.marathon?.paused);
  if (marathonActive) {
    maxSteps = Math.max(maxSteps, 36);
  }

  const detailRank = POWER_LEVEL_RANK[detail] ?? 1;
  const ambitionRank = POWER_LEVEL_RANK[ambition] ?? 1;
  const sensitivityRank = POWER_LEVEL_RANK[sensitivity] ?? 1;
  const staminaRank = POWER_LEVEL_RANK[stamina] ?? 1;
  const peakRank = Math.max(staminaRank, detailRank, ambitionRank, sensitivityRank, marathonActive ? 2 : 0);

  const thinkingDeltaLimit = detailRank >= 4 ? 40_000 : detailRank >= 2 ? 26_000 : 16_000;
  const thinkToolLimit = detailRank >= 4 ? 12_000 : detailRank >= 2 ? 8_000 : 6_000;
  const autoRepairValidation =
    (cfg.mode === 'auto-edit' || cfg.mode === 'full-auto') &&
    (marathonActive || staminaRank >= 2 || sensitivityRank >= 2 || ambitionRank >= 3);
  const timeoutMs = Math.max(
    spec.timeoutMs,
    marathonActive ? 150_000 : 0,
    detailRank >= 4 || ambitionRank >= 4 ? 175_000 : detailRank >= 2 ? 145_000 : 120_000
  );

  return {
    maxSteps: Math.max(4, maxSteps),
    maxFileEdits: marathonActive ? Math.max(spec.maxFileEdits, 140) : spec.maxFileEdits,
    contextBudget: Math.max(cfg.contextBudget || 24_000, spec.contextFloor),
    maxTurnInputChars: spec.maxTurnInputChars,
    timeoutMs: Math.min(timeoutMs, 180_000),
    thinkingDeltaLimit,
    thinkToolLimit,
    autoRepairValidation,
    peakRank,
    boosted: stamina !== 'medium' || detail !== 'medium' || ambition !== 'medium' || sensitivity !== 'medium',
    axes: {
      workStamina: stamina,
      detailThinking: detail,
      ambitionLevel: ambition,
      humanSensitivity: sensitivity
    }
  };
}

export async function getUserAgentConfig(env, owner) {
  const settings = await readUserSettingsObj(env, owner);
  return normalizeAgentConfig(settings.agentConfig, DEFAULT_AGENT_CONFIG);
}

export async function saveUserAgentConfig(env, owner, patch = {}) {
  const settings = await readUserSettingsObj(env, owner);
  if (patch && patch.resetAgentConfig) {
    delete settings.agentConfig;
    await writeUserSettingsObj(env, owner, settings);
    return normalizeAgentConfig({}, DEFAULT_AGENT_CONFIG);
  }
  const current = normalizeAgentConfig(settings.agentConfig, DEFAULT_AGENT_CONFIG);
  const next = normalizeAgentConfig({ ...current, ...(patch || {}) }, current);
  settings.agentConfig = next;
  await writeUserSettingsObj(env, owner, settings);
  return next;
}

/**
 * Build a request-scoped `env` overlay with the user's custom Base URL / API Key
 * (if configured), plus preloaded D1 discovered model capabilities for that Base URL.
 */
export async function resolveEffectiveEnv(env, owner) {
  if (!env?.DB || !owner) return env;
  const [settings, gatewayHealth] = await Promise.all([
    readUserSettingsObj(env, owner),
    loadGatewayHealthMap(env, owner)
  ]);
  const p = settings.provider && typeof settings.provider === 'object' ? settings.provider : null;
  const sbCfg = settings.sandbox && typeof settings.sandbox === 'object' ? settings.sandbox : null;
  const agentConfig = normalizeAgentConfig(settings.agentConfig, DEFAULT_AGENT_CONFIG);

  let primaryKeyPool = [];
  if (p?.apiKeyEnc) {
    const rawDecrypted = await decryptApiKey(env, p.apiKeyEnc);
    primaryKeyPool = String(rawDecrypted || '')
      .split(/[\r\n,|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const customKey = primaryKeyPool[0] || '';

  const storedFallbacks = normalizeStoredFallbacks(p);
  const decryptedFallbacks = [];
  for (let i = 0; i < storedFallbacks.length; i += 1) {
    const fb = storedFallbacks[i];
    if (fb.enabled === false || !fb.baseUrl || !fb.apiKeyEnc) continue;
    const rawFbDecrypted = await decryptApiKey(env, fb.apiKeyEnc);
    const fbPool = String(rawFbDecrypted || '')
      .split(/[\r\n,|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!fbPool.length) continue;
    decryptedFallbacks.push({
      id: fb.id || `gw-${i + 2}`,
      slot: i + 2,
      label: fb.label || '',
      baseUrl: String(fb.baseUrl),
      apiKey: fbPool[0],
      apiKeyPool: fbPool,
      defaultModel: fb.defaultModel ? String(fb.defaultModel) : ''
    });
  }
  const fallbackProvider = decryptedFallbacks[0] || null;

  let customSandboxToken = '';
  if (sbCfg?.tokenEnc) {
    customSandboxToken = await decryptApiKey(env, sbCfg.tokenEnc);
  }
  const useCustomCloudSandbox = Boolean(sbCfg?.mode === 'cloud-url' && sbCfg?.cloudUrl);
  const customBaseUrl = p?.baseUrl ? String(p.baseUrl) : '';
  const customDefaultModel = p?.defaultModel ? String(p.defaultModel) : '';
  const hasCustom = Boolean(customBaseUrl || customKey || customDefaultModel || decryptedFallbacks.length > 0);

  const effectiveBaseUrl = customBaseUrl || effectiveBaseUrlFromEnv(env);
  const effectivePrimaryKey = customKey || env.MODEL_API_KEY || '';
  const discoveredMap = await loadDiscoveredSpecs(env, effectiveBaseUrl).catch(() => ({}));

  // If the user pointed at a non-tooken custom provider and didn't set a custom default model,
  // never fall back to tooken-only model IDs (`claude-sonnet-5-5`). Leave `_needsProviderDefaultModel`
  // so `/api/config` and `/api/chat` pick an actual live model served by that provider.
  const isTooken = isTookenUrl(effectiveBaseUrl);
  const resolvedModelName = customDefaultModel
    ? customDefaultModel
    : !isTooken && customBaseUrl
      ? ''
      : env.MODEL_NAME || 'claude-sonnet-5-5';

  const gatewayChain = [];
  if (effectiveBaseUrl && effectivePrimaryKey) {
    gatewayChain.push({
      id: 'gw-1',
      slot: 1,
      label: 'درگاه ۱',
      baseUrl: effectiveBaseUrl,
      apiKey: effectivePrimaryKey,
      apiKeyPool: primaryKeyPool.length > 1 ? primaryKeyPool : [effectivePrimaryKey],
      defaultModel: resolvedModelName
    });
  }
  for (const fb of decryptedFallbacks) {
    if (gatewayChain.length >= MAX_PROVIDER_GATEWAYS) break;
    gatewayChain.push(fb);
  }

  return {
    ...env,
    MODEL_BASE_URL: effectiveBaseUrl,
    MODEL_API_KEY: effectivePrimaryKey,
    MODEL_NAME: resolvedModelName,
    MODEL_FALLBACK: !isTooken && customBaseUrl ? 'off' : env.MODEL_FALLBACK,
    SANDBOX_URL: useCustomCloudSandbox ? String(sbCfg.cloudUrl) : env.SANDBOX_URL,
    SANDBOX_TOKEN: useCustomCloudSandbox ? (customSandboxToken || '') : env.SANDBOX_TOKEN,
    CONTEXT_BUDGET_TOKENS:
      settings.agentConfig?.contextBudget ? String(agentConfig.contextBudget) : env.CONTEXT_BUDGET_TOKENS,
    _owner: owner,
    _customProvider: hasCustom,
    _apiKeyPool: primaryKeyPool.length > 1 ? primaryKeyPool : null,
    _fallbackProvider: fallbackProvider,
    _gatewayChain: gatewayChain,
    _gatewayHealth: gatewayHealth,
    _customSandbox: useCustomCloudSandbox,
    _sandboxMode: VALID_SANDBOX_MODES.includes(sbCfg?.mode) ? sbCfg.mode : 'auto',
    _agentConfig: agentConfig,
    _discoveredSpecs: discoveredMap
  };
}

export async function getUserTokenCap(env, owner) {
  const settings = await readUserSettingsObj(env, owner);
  const cap = Number(settings.tokenCap);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
}

export async function saveUserTokenCap(env, owner, rawCap) {
  const settings = await readUserSettingsObj(env, owner);
  if (rawCap === null || rawCap === undefined || rawCap === '' || Number(rawCap) <= 0) {
    delete settings.tokenCap;
  } else {
    const num = Math.floor(Number(rawCap));
    if (!Number.isFinite(num) || num < 100 || num > 1_000_000_000_000) {
      fail('مقدار سقف توکن معتبر نیست.', 400, 'bad_token_cap');
    }
    settings.tokenCap = num;
  }
  await writeUserSettingsObj(env, owner, settings);
  return getUserTokenCap(env, owner);
}

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

async function modelsMetaKey(baseUrl) {
  const norm = effectiveBaseUrlFromEnv({ MODEL_BASE_URL: baseUrl }).toLowerCase();
  const hash = await sha256Hex(norm);
  return `mcat2:${hash.slice(0, 20)}`;
}

export async function loadCachedProviderModels(env, baseUrl) {
  if (!env?.DB || !baseUrl) return null;
  await ensureSchema(env);
  const key = await modelsMetaKey(baseUrl);
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) return null;
    if (!parsed.at || Date.now() - parsed.at > MODEL_LIST_CACHE_TTL_MS) return null;
    return parsed.models;
  } catch {
    return null;
  }
}

export async function saveCachedProviderModels(env, baseUrl, models) {
  if (!env?.DB || !baseUrl || !Array.isArray(models) || !models.length) return;
  try {
    await ensureSchema(env);
    const key = await modelsMetaKey(baseUrl);
    const slim = models.length > 2_000 ? models.slice(0, 2_000) : models;
    const serialized = JSON.stringify({ at: Date.now(), models: slim });
    const byteLen = new TextEncoder().encode(serialized).byteLength;
    if (byteLen > 850_000) return;
    await env.DB.prepare(
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
      .bind(key, serialized)
      .run();
  } catch {
    // Non-fatal cache write
  }
}
