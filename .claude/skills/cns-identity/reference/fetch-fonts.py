import os, re, urllib.request

OUT = r"F:\Phoenix Workforce\_wt-cns-identity\.claude\skills\cns-identity\assets\fonts"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
KEEP = ("latin", "arabic")

REQ = [
    ("https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&display=swap", ("latin",)),
    ("https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap", ("latin",)),
    ("https://fonts.googleapis.com/css2?family=Cairo:wght@400;600&display=swap", ("latin", "arabic")),
    ("https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap", ("latin", "arabic")),
]

blocks_out = []
seen = {}
for url, keep in REQ:
    css = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode()  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected — fixed Google Fonts URLs above
    # Google emits  /* subset */\n@font-face{...}
    for m in re.finditer(r"/\*\s*([a-z0-9\-\[\] ]+)\s*\*/\s*(@font-face\s*\{[^}]*\})", css):
        subset, block = m.group(1).strip(), m.group(2)
        if subset not in keep:
            continue
        src = re.search(r"url\((https://[^)]+\.woff2)\)", block)
        if not src:
            continue
        u = src.group(1)
        name = u.rsplit("/", 1)[-1]
        if name not in seen:
            data = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read()  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected — https-only woff2 URL read out of Google's own CSS
            with open(os.path.join(OUT, name), "wb") as fh:
                fh.write(data)
            seen[name] = len(data)
        blocks_out.append(block.replace(u, name))

header = (
    "/* The four typefaces this identity uses, self-hosted.\n"
    "   Google Fonts is NOT linked: headless Chrome here fails DNS and the page load\n"
    "   fails outright, and even where it resolves a slow fetch silently renders\n"
    "   Playfair as a fallback serif with nothing in the file saying so.\n"
    "   Subsets kept: latin for Playfair Display and Inter, latin + arabic for Cairo\n"
    "   and Amiri. Regenerate with reference/fetch-fonts.py. */\n"
)
with open(os.path.join(OUT, "fonts.css"), "w", encoding="utf-8") as fh:
    fh.write(header + "\n".join(blocks_out) + "\n")

total = sum(seen.values())
for n, s in sorted(seen.items()):
    print(f"  {n:52s} {s/1024:7.1f} KB")
print(f"{len(seen)} files, {total/1024:.0f} KB, {len(blocks_out)} @font-face blocks")
