const has = typeof Uint8Array.fromBase64 === 'function';
console.log('Uint8Array.fromBase64 available:', has, '| TextDecoder latin1:', !!new TextDecoder('latin1'));

function mkB64(n) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = 32 + (i % 95);
  return Buffer.from(b).toString('base64'); }
const B64 = mkB64(160_000);

function A_decode(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function E_decode(b64) { const bin = atob(b64); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
function C_decode(b64) { if (!has) return A_decode(b64); return Uint8Array.fromBase64(b64.slice(0, b64.length & ~3)); }
const TBL = (() => { const t = new Int16Array(128).fill(-1); const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; for (let i = 0; i < s.length; i++) t[s.charCodeAt(i)] = i; return t; })();
function D_decode(b64) { const n = (b64.length >> 2) * 3; const out = new Uint8Array(n); let p = 0;
  for (let i = 0; i + 4 <= b64.length; i += 4) { const a = TBL[b64.charCodeAt(i)] || 0, b = TBL[b64.charCodeAt(i+1)] || 0, c = TBL[b64.charCodeAt(i+2)] || 0, d = TBL[b64.charCodeAt(i+3)] || 0;
    out[p++] = (a << 2) | (b >> 4); out[p++] = ((b & 15) << 4) | (c >> 2); out[p++] = ((c & 3) << 6) | d; } return out; }

for (const [label, fn] of [['A atob+loop', A_decode], ['C fromBase64', C_decode], ['D table', D_decode]]) {
  const rep = []; for (let r = 0; r < 7; r++) { const t = performance.now(); const u = fn(B64); rep.push(performance.now() - t); if (!r) var L = u.length; }
  rep.sort((a, b) => a - b);
  console.log('decode', label.padEnd(14), 'median', rep[3].toFixed(3) + 'ms', 'min', rep[0].toFixed(3), 'bytes', L);
}
console.log('C==A ?', Buffer.compare(Buffer.from(C_decode(B64)), Buffer.from(A_decode(B64).buffer, A_decode(B64).byteOffset, A_decode(B64).length)) === 0);
console.log('D==A ?', Buffer.compare(Buffer.from(D_decode(B64)), Buffer.from(A_decode(B64))) === 0);
