import re

p = 'tests/super-nova.test.mjs'
s = open(p, encoding='utf-8').read()

if 'function makeCanvasStub' not in s:
    # 1) insert canvas stub factory right after canvasStub definition block
    anchor = "const canvasStub = {"
    idx = s.index(anchor)
    factory = """function makeCanvasStub() {
  const stub = {
    width: 960, height: 540, style: {},
    tagName: 'CANVAS',
    getContext() { return canvasCtx; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { if (k === 'width') stub.width = Number(v); if (k === 'height') stub.height = Number(v); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
  };
  return stub;
}
const CANVAS_CTX_CALLS = { ops: 0 };
const canvasCtx = {
  canvas: null,
  globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
  font: '10px sans-serif', textAlign: 'left', textBaseline: 'top',
  shadowBlur: 0, shadowColor: 'transparent', globalCompositeOperation: 'source-over',
  lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
  filter: 'none', imageSmoothingEnabled: true,
  save() {}, restore() {}, beginPath() {}, closePath() {},
  moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {},
  arc() {}, arcTo() {}, ellipse() {}, rect() {}, fill() {}, stroke() {},
  clip() {}, fillRect() {}, strokeRect() {}, clearRect() {},
  fillText() { CANVAS_CTX_CALLS.ops += 1; }, strokeText() {},
  translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {},
  resetTransform() {}, drawImage() {}, createLinearGradient() { return { addColorStop() {} }; },
  createRadialGradient() { return { addColorStop() {} }; },
  createPattern() { return null; }, measureText() { return { width: 0 }; },
  getLineDash() { return []; }, setLineDash() {},
  putImageData() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
  createImageData() { return { data: new Uint8ClampedArray(4) }; },
  isPointInPath() { return false; }, roundRect() {},
};
const canvasStub = makeCanvasStub();
"""
    s = s[:idx] + factory + s[idx + anchor.__len__():]
    # remove the old canvasStub body: find from new canvasStub's "= makeCanvasStub();" up to its closing "};" then any trailing old props
    start = s.index('const canvasStub = makeCanvasStub();')
    end = s.index('};', start) + 2
    s = s[:start] + 'const canvasStub = makeCanvasStub();' + s[end:]
    open(p, 'w', encoding='utf-8').write(s)
    print('factory inserted')
