// Static checks the agent runs on its own edits before handing them back.
//
// The goal is not a full linter — it is catching the mistakes an LLM actually
// makes: unbalanced braces, an unclosed quote, a dangling `</script>` inside a
// template, a stray `undefined` in JSON, broken HTML tags.
//
// Results are advisory text (never throw), so a warning can never block a save
// that the user explicitly asked for.

const MAX_CHARS = 900_000;

/* --------------------------------- bracket -------------------------------- */

const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/**
 * Scan code ignoring string/template/comment content.
 * Returns { balanced, firstError, depth, inComment }.
 */
export function checkBrackets(source, { language = 'js' } = {}) {
  const text = String(source || '');
  if (text.length > MAX_CHARS) return { balanced: true, skipped: true };

  const stack = [];
  let state = 'code'; // code | line | block | single | double | template
  let line = 1;
  let column = 0;
  let templateDepth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '\n') {
      line += 1;
      column = 0;
      if (state === 'line') state = 'code';
    } else {
      column += 1;
    }

    if (state === 'line') continue;
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        i += 1;
        column += 1;
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) state = 'code';
      continue;
    }
    if (state === 'template') {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === '`' && templateDepth === 0) {
        state = 'code';
        continue;
      }
      if (char === '$' && next === '{') {
        templateDepth += 1;
        stack.push({ char: '{', line, column, template: true });
        state = 'code';
        i += 1;
        continue;
      }
      continue;
    }

    // code state
    if (char === '/' && next === '/') {
      state = 'line';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block';
      i += 1;
      continue;
    }
    if (char === "'") {
      state = 'single';
      continue;
    }
    if (char === '"') {
      state = 'double';
      continue;
    }
    if (char === '`') {
      state = 'template';
      templateDepth = 0;
      continue;
    }
    if (PAIRS[char]) {
      stack.push({ char, line, column });
      continue;
    }
    if (CLOSERS.has(char)) {
      const top = stack.pop();
      if (!top) return { balanced: false, firstError: { line, column, message: `«${char}» بسته‌ی باز ندارد` } };
      if (PAIRS[top.char] !== char) {
        return {
          balanced: false,
          firstError: {
            line,
            column,
            message: `«${char}» بسته‌ی «${top.char}» را می‌بندد؛ انتظار «${PAIRS[top.char]}» بود (باز در خط ${top.line})`
          }
        };
      }
      if (top.template) {
        templateDepth = Math.max(0, templateDepth - 1);
        state = 'template';
      }
    }
  }

  if (state === 'single' || state === 'double' || state === 'template') {
    return { balanced: false, firstError: { line, column, message: `${state === 'single' ? "'" : state === 'double' ? '"' : '`'} بسته نشده است` } };
  }
  if (state === 'block') {
    return { balanced: false, firstError: { line, column, message: 'کامنت /* بسته نشده است' } };
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return {
      balanced: false,
      firstError: { line: top.line, column: top.column, message: `«${top.char}» بسته نشده است` }
    };
  }
  return { balanced: true };
}

/* ---------------------------------- HTML --------------------------------- */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Very small HTML well-formedness check (tag nesting + script/style balance).
 * Deliberately lenient: it reports the first structural problem only.
 */
export function checkHtml(source) {
  const text = String(source || '');
  if (text.length > MAX_CHARS) return { ok: true, skipped: true };
  const stack = [];
  const tagRegex = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let match;
  while ((match = tagRegex.exec(text))) {
    const full = match[0];
    if (full.startsWith('<!--') || /^<!doctype/i.test(full)) continue;
    const name = match[1].toLowerCase();
    const isClose = full.startsWith('</');
    const selfClosing = /\/\s*>$/.test(full) || VOID_TAGS.has(name);
    if (selfClosing && !isClose) continue;
    if (!isClose && (name === 'script' || name === 'style')) {
      // HTML5 raw-text elements: JS/CSS inside <script> or <style> may contain
      // `<div`, `<script`, or `x < y` comparisons that are NOT HTML tags.
      const closeRaw = name === 'script' ? /<\/script\s*>/gi : /<\/style\s*>/gi;
      closeRaw.lastIndex = tagRegex.lastIndex;
      const endMatch = closeRaw.exec(text);
      if (!endMatch) {
        return { ok: false, message: `تگ <${name}> بسته نشده است` };
      }
      tagRegex.lastIndex = closeRaw.lastIndex;
      continue;
    }
    if (!isClose) {
      stack.push(name);
    } else {
      const top = stack.pop();
      if (top !== name) {
        return { ok: false, message: `تگ </${name}> انتظار </${top || '—'}> را داشت` };
      }
    }
  }
  if (stack.length) {
    return { ok: false, message: `تگ <${stack[stack.length - 1]}> بسته نشده است` };
  }
  return { ok: true };
}

/* ---------------------------------- JSON ---------------------------------- */

export function checkJson(source) {
  const text = String(source || '').trim();
  if (!text) return { ok: true };
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error.message || 'JSON نامعتبر').slice(0, 200) };
  }
}

/* -------------------------------- aggregate ------------------------------- */

/** Guess the language from the path. */
export function languageOfPath(path) {
  const value = String(path || '');
  if (/\.json$/i.test(value)) return 'json';
  if (/\.html?$/i.test(value)) return 'html';
  if (/\.css$/i.test(value)) return 'css';
  if (/\.(m?js|jsx|cjs|ts|tsx)$/i.test(value)) return 'js';
  if (/\.md$/i.test(value)) return 'md';
  return 'text';
}

/**
 * Validate one file. Returns { ok, errors[], warnings[] } — never throws.
 * `errors` are structural problems worth reporting to the model as a hint.
 */
export function validateFile(path, content) {
  const language = languageOfPath(path);
  const text = String(content ?? '');
  const errors = [];
  const warnings = [];

  if (!text.trim()) {
    warnings.push('فایل خالی است');
  }

  if (language === 'json') {
    const result = checkJson(text);
    if (!result.ok) errors.push(`JSON نامعتبر: ${result.message}`);
  }

  if (language === 'html') {
    const result = checkHtml(text);
    if (!result.ok) errors.push(`HTML: ${result.message}`);
    if (!/<html[\s>]/i.test(text) && /<head[\s>]|<body[\s>]/i.test(text)) {
      warnings.push('تگ <html> دیده نمی‌شود');
    }
  }

  if (language === 'js' || language === 'css') {
    const result = checkBrackets(text, { language });
    if (!result.balanced && result.firstError) {
      errors.push(`${language.toUpperCase()}: خط ${result.firstError.line} — ${result.firstError.message}`);
    }
  }

  if (language === 'js') {
    // The preview inlines app.js into index.html, so a literal </script> in a
    // JS file would terminate the tag early and break the rendered page.
    if (/<\/script/i.test(text)) {
      errors.push('JS: رشته‌ی «</script» در فایل هست؛ در پیش‌نمایش، تگ اسکریپت را می‌بندد. آن را به «<\\/script» تغییر دهید');
    }
  }

  if (language === 'css') {
    const opens = (text.match(/{/g) || []).length;
    const closes = (text.match(/}/g) || []).length;
    if (opens !== closes) warnings.push(`تعداد آکولاد باز/بسته برابر نیست (${opens}/${closes})`);
  }

  const secrets = scanForSecrets(text);
  if (secrets.length) {
    warnings.push(
      `احتمال وجود اعتبارنامه در خط ${secrets.slice(0, 5).map((s) => s.line).join('، ')} — آن را از فایل بردارید و در Secrets ذخیره کنید`
    );
  }

  return { ok: errors.length === 0, language, errors, warnings, secrets };
}

/* ------------------------------ secret scan ------------------------------- */

const SECRET_SHAPES = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/,
  /\btc_(?:live|test)_[A-Za-z0-9_-]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
];

/**
 * Report (never modify) credential-shaped literals in a file.
 * Returns [{ line, kind }] so the UI can point at the exact spot.
 */
export function scanForSecrets(source) {
  const text = String(source || '');
  if (!text) return [];
  const found = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const shape of SECRET_SHAPES) {
      if (shape.test(line)) {
        found.push({ line: index + 1, kind: 'credential' });
        break;
      }
    }
    if (found.length >= 20) break;
  }
  return found;
}

/** Validate every changed file; returns a compact model-facing report. */
export function validateChanges(files, paths) {
  const report = [];
  for (const path of paths) {
    const result = validateFile(path, files[path]);
    if (!result.ok || result.warnings.length) {
      report.push({ path, ...result });
    }
  }
  if (!report.length) return { ok: true, report: [], text: 'Validation passed: no structural problems found.' };
  const lines = report.map((entry) => {
    const parts = [...entry.errors.map((e) => `error: ${e}`), ...entry.warnings.map((w) => `warning: ${w}`)];
    return `${entry.path} → ${parts.join(' | ')}`;
  });
  return { ok: report.every((entry) => entry.ok), report, text: `Validation issues:\n${lines.join('\n')}` };
}
