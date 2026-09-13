from pathlib import Path

p = Path(__file__).resolve().parent / 'public' / 'index.html'
s = p.read_text(encoding='utf-8')
old = "['validate','Validate link','Checking the URL and security rules.'],\n    ['read_info','Read media information','Finding the title, formats and available quality.'],"
new = "['validate','Validate link','Checking the URL and security rules.'],\n    ['resolve','Detect media type','Determining the media type before reading its information.'],\n    ['read_info','Read media information','Finding the title, formats and available quality.'],"
if old not in s:
    raise SystemExit('Normal stage list target not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('stage UI patched')
