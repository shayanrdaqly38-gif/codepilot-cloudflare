// Honest benchmark of the CURRENT extractReadableStrings implementation (copied verbatim).
function redactSecrets(s) {
  // stand-in with same regex workload class as util.redactSecrets
  return s
    .replace(/(?:sk|pk)-[A-Za-z0-9]{8,}/g, '<redacted>')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '<redacted>');
}
function extractReadableStrings(b64Sample, maxChars = 6000) {
  if (!b64Sample) return '';
  const capped = b64Sample.slice(0, Math.min(b64Sample.length, 160_000) & ~3);
  let bin = '';
  try { bin = atob(capped); } catch { return ''; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!utf8.includes('\0')) return redactSecrets(utf8.slice(0, maxChars));
  } catch { /* not pure utf8 */ }
  const runs = [];
  let current = '';
  let total = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) {
      current += String.fromCharCode(b);
    } else {
      if (current.trim().length >= 6) {
        const clean = current.trim();
        runs.push(clean);
        total += clean.length;
        if (total >= maxChars) break;
      }
      current = '';
    }
  }
  if (current.trim().length >= 6 && total < maxChars) runs.push(current.trim());
  return runs.length ? redactSecrets(runs.join('\n').slice(0, maxChars)) : '';
}

const CHUNK = 192000;
const header = Buffer.alloc(CHUNK, 0);
Buffer.from('%PDF-1.7 Sample Embedded Text Inside Large Binary').copy(header, 0);
const b0 = header.toString('base64');

// realistic 2nd chunk: ascii-ish text so UTF-8 fast path applies
const textChunk = Buffer.concat([Buffer.from('Lorem ipsum dolor sit amet consectetur. '.repeat(4000))]);
const t0 = performance.now();
for (let i = 0; i < 10; i++) extractReadableStrings(b0, 8000);
const t1 = performance.now();
for (let i = 0; i < 10; i++) extractReadableStrings(textChunk.toString('base64'), 8000);
const t2 = performance.now();
console.log('PDF-header chunk :', ((t1 - t0) / 10).toFixed(2), 'ms/call');
console.log('ASCII text chunk :', ((t2 - t1) / 10).toFixed(2), 'ms/call');
console.log('--- node', process.version, process.arch);
