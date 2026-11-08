p = 'tests/super-nova.test.mjs'
s = open(p, encoding='utf-8').read()

if 'createElement' in s and 'canvasStub' in s.split('createElement')[1][:400]:
    print('already wired')
else:
    old_create = "createElement(tag) { return makeEl((tag || 'div').toLowerCase()); },"
    new_create = """createElement(tag) {
    const t = (tag || 'div').toLowerCase();
    return t === 'canvas' ? makeCanvasStub() : makeEl(t);
  },"""
    if old_create in s:
        s = s.replace(old_create, new_create)
        print('createElement wired')

    old_get = "getElementById(id) { return (elements[id] ??= makeEl('div')); },"
    new_get = """getElementById(id) {
    if (elements[id]) return elements[id];
    const known = (typeof canvasIds !== 'undefined' && canvasIds.has(id));
    return (elements[id] ??= known ? makeCanvasStub() : makeEl('div'));
  },"""
    if old_get in s:
        s = s.replace(old_get, new_get)
        print('getElementById wired')

    open(p, 'w', encoding='utf-8').write(s)
