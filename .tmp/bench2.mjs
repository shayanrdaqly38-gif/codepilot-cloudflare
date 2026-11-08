const dec = new TextDecoder('latin1');
function v1(bytes, maxChars = 6000) {
  const runs = []; let current = ''; let total = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) current += String.fromCharCode(b);
    else { if (current.trim().length >= 6) { const clean = current.trim(); runs.push(clean); total += clean.length; if (total >= maxChars) break; } current = ''; }
  }
  if (current.trim().length >= 6 && total < maxChars) runs.push(current.trim());
  return runs.join('\n').slice(0, maxChars);
}
function v2(bytes, maxChars = 6000) {
  const n = bytes.length; let out = ''; let total = 0; let i = 0;
  const PR = (b) => (b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13;
  while (i < n && total < maxChars) {
    if (!PR(bytes[i])) { i += 1; continue; }
    let e = i + 1; while (e < n && PR(bytes[e])) e += 1;
    let a = i; while (a < e && bytes[a] === 32) a += 1;
    let z = e; while (z > a && (bytes[z-1] === 9 || bytes[z-1] === 10 || bytes[z-1] === 13 || bytes[z-1] === 32)) z -= 1;
    const len = z - a;
    if (len >= 6) { if (out) out += '\n'; out += dec.decode(bytes.subarray(a, z)); total += len; }
    i = e + 1;
  }
  return out.slice(0, maxChars);
}
function v3(bytes, maxChars = 6000) {
  const n = bytes.length;
  const s = dec.decode(bytes); // latin1 1:1
  let out = ''; let total = 0; let i = 0;
  while (i < n && total < maxChars) {
    const c = s.charCodeAt(i);
    if (!((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13)) { i += 1; continue; }
    let e = i + 1; while (e < n) { const d = s.charCodeAt(e); if (!((d >= 32 && d <= 126) || d === 9 || d === 10 || d === 13)) break; e += 1; }
    let a = i; while (a < e && s.charCodeAt(a) === 32) a += 1;
    let z = e; while (z > a && (s.charCodeAt(z-1) === 9 || s.charCodeAt(z-1) === 10 || s.charCodeAt(z-1) === 13 || s.charCodeAt(z-1) === 32)) z -= 1;
    const len = z - a; if (len >= 6) { if (out) out += '\n'; out += s.slice(a, z); total += len; }
    i = e + 1;
  }
  return out.slice(0, maxChars);
}
const CH = 200 * 1024;
const mkAscii = () => { const b = new Uint8Array(CH); for (let i = 0; i < CH; i++) b[i] = 32 + (i % 95); return b; };
const mkBin = () => { const b = new Uint8Array(CH); for (let i = 0; i < CH; i++) b[i] = (i % 60 < 55) ? 65 + (i % 26) : 0; return b; };
const mkText = () => { const b = new Uint8Array(CH); for (let i = 0; i < CH; i++) b[i] = (i % 24 < 20) ? 97 + (i % 26) : 10; return b; };
for (const [nm, mk] of [['ascii-continuous', mkAscii], ['pdf-keywords', mkBin], ['real-text-lines', mkText]]) {
  const buf = mk();
  const exp = v1(buf).slice(0, 6000);
  for (const [label, fn] of [['v1 per-char', v1], ['v2 TextDecoder', v2], ['v3 string-scan', v3]]) {
    const rep = []; for (let r = 0; r < 7; r++) { const t = performance.now(); const out = fn(buf); rep.push(performance.now() - t); if (!r) var L = out.length; }
    rep.sort((a, b) => a - b);
    console.log(nm.padEnd(20), label.padEnd(15), 'median', rep[3].toFixed(3) + 'ms', 'min', rep[0].toFixed(3), 'len', L);
  }
  console.log(nm.padEnd(20), 'v1==v2:', v1(buf).slice(0,6000) === exp ? 'yes' : 'CHECK', '| difflen', (v2(buf).length), (v3(buf).length));
}
console.log('--- equality check ---');
for (const [nm, mk] of [['ascii-continuous', mkAscii], ['pdf-keywords', mkBin], ['real-text-lines', mkText]]) {
  const buf = mk(); const a = v1(buf), b = v2(buf), c = v3(buf);
  console.log(nm.padEnd(20), 'v1==v2', a === b, '| v1==v3', a === c, '| v2==v3', b === c);
}
