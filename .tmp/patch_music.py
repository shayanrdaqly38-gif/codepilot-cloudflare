p = 'super-nova.html'
s = open(p, encoding='utf-8').read()

block = """music.setSong = function(st) { this.setState(String(st)); };
music.pause = function() { if (this.timer) { clearInterval(this.timer); this.timer = null; this.on = false; } };
music.resume = function() { this.refresh(); };
"""
if block not in s:
    raise SystemExit('block missing')

# 1) remove late definition
s = s.replace(block, '', 1)

# 2) inject methods into music object (before closing brace of scheduleStep at line ~396)
anchor = "  },\n};"
idx = s.find("const music = {")
if idx < 0:
    raise SystemExit('music anchor missing')
end = s.find("  },\n};", idx)
if end < 0:
    raise SystemExit('music body end missing')
inject = """  },
  setSong(st) { this.setState(String(st)); },
  pause() { if (this.timer) { clearInterval(this.timer); this.timer = null; this.on = false; } },
  resume() { this.refresh(); }"""
s = s[:end] + inject + s[end + len("  },\n};"):]

open(p, 'w', encoding='utf-8').write(s)
print('music methods moved inline')
