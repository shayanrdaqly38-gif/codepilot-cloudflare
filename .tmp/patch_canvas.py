import re,io
p='tests/super-nova.test.mjs'
s=open(p,encoding='utf-8').read()
# ensure getElementById returns canvasStub for canvas ids (already patched earlier) - verify
assert 'canvasIds' in s, 'canvasIds patch missing'
print('canvasIds present OK')
print([l for l in s.splitlines() if 'createElement' in l][:3])
