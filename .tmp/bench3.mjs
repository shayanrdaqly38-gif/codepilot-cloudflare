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
  const parts = []; let out = ''; let start = -1; let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    const printable = (b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13;
    if (!printable) { if (start !== -1) { parts.push(start, i); start = -1; } i++; continue; }
    if (start !== -1) { i++; continue; }
    let s = i, e = i + 1;
    while (e < n) { const c = bytes[e]; if (!((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13)) break; e++; }
    let a = s; while (a < e && (bytes[a] === 9 || bytes[a] === 10 || bytes[a] === 13 || bytes[a] === 32)) a++;
    let z = e; while (z > a && (bytes[z-1] === 9 || bytes[z-1] === 10 || bytes[z-1] === 13 || bytes[z-1] === 32)) z--;
    if (z - a >= 6) { if (out) out += '\n'; out += String.fromCharCode.apply(null, bytes.subarray(a, z)); parts.push(0); if (out.length >= maxChars) return out.slice(0, maxChars); }
    i = e + 1;
  }
  return out.slice(0, maxChars);
}
const CH = 200 * 1024;
const ascii = new Uint8Array(CH); for (let i = 0; i < CH; i++) ascii[i] = 32 + (i % 95);
const pdf = new Uint8Array(CH); for (let i = 0; i < CH; i++) pdf[i] = (i % 60 < 55) ? 65 + (i % 26) : 0;
for (const [name, buf] of [['ascii', ascii], ['pdfish', pdf]]) {
  for (const [label, fn] of [['v1', v1], ['v2', v2]]) {
    const rep = []; for (let r = 0; r < 5; r++) { const t = performance.now(); const out = fn(buf); rep.push(performance.now() - t); if (!r) var L = out.length; }
    rep.sort((a,b)=>a-b);
    console.log(name, label, 'median', rep[2].toFixed(3) + 'ms', 'min', rep[0].toFixed(3), 'len', L);
  }
  console.log('same?', v1(buf).slice(0, 3000) === v2(buf).slice(0, 3000) ? 'YES' : 'NO');
}
