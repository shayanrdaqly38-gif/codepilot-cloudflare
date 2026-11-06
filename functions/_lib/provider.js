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

  const effectiveBase = customBaseUrl || serverBaseUrl;
  const fallbackDefModel = isOpenRouterUrl(effectiveBase)
    ? 'openrouter/auto'
    : String(env?.MODEL_NAME || 'claude-sonnet-5-5');

  return {
    customActive,
    usingCustom: customActive,
    baseUrl: customBaseUrl,
    effectiveBaseUrl: effectiveBase,
    serverBaseUrl,
    hasCustomKey,
    keyHint: p?.keyHint ? String(p.keyHint) : '',
    hasServerKey,
    defaultModel: customDefaultModel,
    effectiveDefaultModel: customDefaultModel || fallbackDefModel
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
  } else if (typeof input.apiKey === 'string') {
    const cleanedKey = cleanCredentialInput(input.apiKey).replace(/^bearer\s+/i, '').trim();
    if (cleanedKey) {
      if (cleanedKey.length > 2048 || /\s/.test(cleanedKey)) {
        fail('قالب کلید API معتبر نیست (فاصله یا کاراکتر اضافی را حذف کنید).', 400, 'bad_api_key');
      }
      apiKeyEnc = await encryptApiKey(env, cleanedKey);
      keyHint = maskApiKey(cleanedKey);
    }
  }

  let defaultModel = prev.defaultModel || '';
  if (input.defaultModel !== undefined) {
    const candidate = cleanCredentialInput(input.defaultModel);
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

export const VALID_AGENT_MODES = ['plan', 'suggest', 'auto-edit', 'full-auto'];
export const VALID_RESPONSE_STYLES = ['balanced', 'concise', 'explanatory', 'senior-reviewer'];
export const VALID_THEMES = ['claude-warm', 'claude-day', 'midnight'];
export const VALID_POWER_LEVELS = ['low', 'medium', 'hard', 'very-hard', 'max', 'ultra-code'];

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
  const settings = await readUserSettingsObj(env, owner);
  const p = settings.provider && typeof settings.provider === 'object' ? settings.provider : null;
  const agentConfig = normalizeAgentConfig(settings.agentConfig, DEFAULT_AGENT_CONFIG);

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
  // never fall back to tooken-only model IDs (`claude-sonnet-5-5`). Leave `_needsProviderDefaultModel`
  // so `/api/config` and `/api/chat` pick an actual live model served by that provider.
  const isTooken = isTookenUrl(effectiveBaseUrl);
  const resolvedModelName = customDefaultModel
    ? customDefaultModel
    : !isTooken && customBaseUrl
      ? ''
      : env.MODEL_NAME || 'claude-sonnet-5-5';

  return {
    ...env,
    MODEL_BASE_URL: effectiveBaseUrl,
    MODEL_API_KEY: customKey || env.MODEL_API_KEY || '',
    MODEL_NAME: resolvedModelName,
    MODEL_FALLBACK: !isTooken && customBaseUrl ? 'off' : env.MODEL_FALLBACK,
    CONTEXT_BUDGET_TOKENS:
      settings.agentConfig?.contextBudget ? String(agentConfig.contextBudget) : env.CONTEXT_BUDGET_TOKENS,
    _customProvider: hasCustom,
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
  return `mcat:${hash.slice(0, 20)}`;
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
    const slim = models.slice(0, 220);
    const serialized = JSON.stringify({ at: Date.now(), models: slim });
    if (serialized.length > 180_000) return;
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
