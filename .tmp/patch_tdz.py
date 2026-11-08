import io, sys
p = 'super-nova.html'
s = io.open(p, encoding='utf-8').read()
lines = s.split('\n')
# 1-indexed line numbers in `lines` are offset by 1
BLOCK_START = 889   # EnemyBase.prototype._drawBase = function (ctx) {
BLOCK_END = 916     # exclusive: line 916 is "function drawEnemies(ctx) {"
COMMENT_LINE = 888  # " /* ---- رسم عمومی دشمنان ---- */"
anchor = 'function spawnBoss(level) {'
anchor_idx = None
for i, ln in enumerate(lines):
    if ln.startswith('function spawnBoss(level) {'):
        anchor_idx = i
        break
assert anchor_idx is not None, 'spawnBoss anchor not found'
# move block: lines[COMMENT_LINE-1 : BLOCK_END-1]  (comment + block)
block = lines[COMMENT_LINE-1:BLOCK_END-1]
# sanity: block must start with comment and end with '};'
assert block[0].lstrip().startswith('/*'), 'block start mismatch'
assert block[-1] == '};', 'block end mismatch'
assert 'EnemyBase.prototype._drawBase' in block[1], 'prototype line missing'
# insert after index of line "}" closing spawnBoss => find the '}' at same indent after anchor_idx
j = anchor_idx
while j < len(lines) and lines[j] != '}':
    j += 1
assert j < len(lines), 'spawnBoss closing brace not found'
new = (lines[:COMMENT_LINE-1] + lines[BLOCK_END-1:j+1] + block + lines[j+1:])
io.open(p, 'w', encoding='utf-8').write('\n'.join(new))
print('moved block of', len(block), 'lines -> after line', j+1)
