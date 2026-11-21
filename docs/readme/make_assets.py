#!/usr/bin/env python3
"""Generates the README images in the xand0dev profile style. Run: python3 docs/readme/make_assets.py"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "images" / "readme"
OUT.mkdir(parents=True, exist_ok=True)

HEAD = """<style>
.s{font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif} .m{font-family:ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes dash{to{stroke-dashoffset:-14}}
.breathe{animation:breathe 4s ease-in-out infinite}
.flow{stroke-dasharray:3 4;animation:dash 1.6s linear infinite}
@media (prefers-reduced-motion:reduce){.breathe,.flow{animation:none}}
.compact{display:none} @media (max-width:BPpx){.full{display:none} .compact{display:inline}}</style>
<defs>
<linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#34363B"/><stop offset=".5" stop-color="#16171A"/><stop offset="1" stop-color="#26282C"/>
</linearGradient>
<filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
  <feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
<radialGradient id="redLight"><stop offset="0" stop-color="#E0101A" stop-opacity=".5"/>
  <stop offset=".4" stop-color="#E0101A" stop-opacity=".12"/><stop offset="1" stop-color="#E0101A" stop-opacity="0"/></radialGradient>
<linearGradient id="hair" x1="0" x2="1"><stop offset="0" stop-color="#8B8F96" stop-opacity=".45"/><stop offset="1" stop-color="#8B8F96" stop-opacity="0"/></linearGradient>
</defs>
"""


def svg(name: str, w: int, h: int, label: str, body: str, bp: int = 300) -> None:
    doc = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{label}">\n'
        f"<title>{label}</title>\n" + HEAD.replace("BP", str(bp)) + body + "\n</svg>\n"
    )
    (OUT / name).write_text(doc, encoding="utf-8")


def frame(w: int, h: int, rx: int = 16) -> str:
    return f'<rect x="1" y="1" width="{w - 2}" height="{h - 2}" rx="{rx}" fill="#050506" stroke="url(#edge)" stroke-width="1.5"/>\n'


def text(x, y, s, size, fill, cls="s", weight=None, ls=None, anchor=None):
    a = [f'x="{x}"', f'y="{y}"', f'class="{cls}"', f'font-size="{size}"', f'fill="{fill}"']
    if weight:
        a.append(f'font-weight="{weight}"')
    if ls is not None:
        a.append(f'letter-spacing="{ls}"')
    if anchor:
        a.append(f'text-anchor="{anchor}"')
    return f'<text {" ".join(a)} xml:space="preserve">{s}</text>'


def node(x, y, w, h, label, hot=False, size=12):
    stroke = "#FF2A2A" if hot else "#4A4E55"
    fill = "#F2F3F5" if hot else "#C9CDD3"
    cls = ' class="breathe"' if hot else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="#0B0C0E" stroke="{stroke}" stroke-width="1.5"{cls}/>'
            + text(x + 12, y + h / 2 + 4, label, size, fill, "m", 700))


def tag(x, y, s="NEW"):
    w = 10 + len(s) * 7
    return (f'<rect x="{x}" y="{y}" width="{w}" height="17" rx="4" fill="#E0101A"/>'
            + text(x + w / 2, y + 12.5, s, 10, "#FFFFFF", "m", 700, 1, "middle"))


def dots(path, color="#C9CDD3", n=2, dur=1.8, offset=0.0):
    return "".join(
        f'<circle r="3.2" fill="{color}"><animateMotion dur="{dur}s" begin="{offset + i * dur / n:.2f}s" repeatCount="indefinite" path="{path}"/></circle>'
        for i in range(n))


# ── section labels ───────────────────────────────────────────────────────────

def label(name, title):
    w_full = 22 + len(title) * 13 * 0.62 + len(title) * 4 + 18
    w_compact = 26 + len(title) * 36 * 0.62 + len(title) * 6 + 24
    body = (
        '<circle cx="5" cy="27" r="3.5" fill="#FF2A2A" filter="url(#glow)"/>\n'
        f'<g class="full">{text(22, 32, title, 13, "#8B8F96", "m", 700, 4)}\n'
        f'<rect x="{w_full:.0f}" y="26.5" width="{1200 - w_full:.0f}" height="1.5" fill="url(#hair)"/></g>\n'
        f'<g class="compact">{text(26, 41, title, 36, "#8B8F96", "m", 700, 6)}\n'
        f'<rect x="{w_compact:.0f}" y="26" width="{max(80, 1200 - w_compact):.0f}" height="3" fill="url(#hair)"/></g>'
    )
    svg(name, 1200, 52, title.title(), body, bp=560)


for n, t in [("label-see.svg", "SEE IT"), ("label-views.svg", "FOUR THINGS IT DOES"), ("label-run.svg", "RUN IT"),
             ("label-agents.svg", "CONNECT YOUR AGENT"), ("label-traffic.svg", "LIVE TRAFFIC"), ("label-how.svg", "HOW IT WORKS")]:
    label(n, t)


# ── feature cards (600 × 300) ────────────────────────────────────────────────

def card(name, kicker, title, lines, art, alt):
    body = frame(600, 300)
    body += '<g class="full">\n'
    body += text(36, 52, kicker, 12, "#5E636B", "m", 700, 2.4) + "\n"
    body += text(34, 104, title, 34, "#F2F3F5", "s", 800, -1.1) + "\n"
    for i, line in enumerate(lines):
        body += text(36, 146 + i * 26, line, 18, "#9A9FA7") + "\n"
    body += art + "\n</g>\n"
    body += f'<g class="compact">{text(36, 120, title, 64, "#F2F3F5", "s", 800, -2)}</g>'
    svg(name, 600, 300, alt, body)


map_art = (
    '<g fill="none" stroke-width="1.5">'
    '<path class="flow" d="M462 92 C478 92 478 92 494 92" stroke="#4A4E55"/>'
    '<path class="flow" d="M462 92 C478 92 478 140 494 140" stroke="#4A4E55"/>'
    '<path class="flow" d="M462 188 C478 188 478 140 494 140" stroke="#4A4E55"/>'
    '<path class="flow" d="M552 92 C562 92 562 116 572 116" stroke="#4A4E55"/>'
    '<path class="flow" d="M552 140 C562 140 562 116 572 116" stroke="#4A4E55"/>'
    '<path class="flow" d="M552 140 C562 140 562 196 572 196" stroke="#4A4E55"/>'
    '</g>'
    + "".join(f'<rect x="404" y="{y}" width="58" height="26" rx="5" fill="#0B0C0E" stroke="#4A4E55" stroke-width="1.3"/>' for y in (79, 127, 175))
    + "".join(f'<rect x="494" y="{y}" width="58" height="26" rx="5" fill="#0B0C0E" stroke="#4A4E55" stroke-width="1.3"/>' for y in (79, 127))
    + "".join(f'<rect x="572" y="{y}" width="14" height="26" rx="4" fill="#0B0C0E" stroke="#4A4E55" stroke-width="1.3"/>' for y in (103, 183))
    + text(404, 236, "WEB  API  DB", 11, "#5E636B", "m", 700, 1.6)
)
card("card-map.svg", "MAP", "What is what",
     ["Any project, any language. Every", "part gets a picture and a plain", "description, free, no AI."],
     map_art, "Map: any project in any language, every part with a picture and a plain description, without AI.")

changes_art = (
    f'<circle cx="490" cy="140" r="120" fill="url(#redLight)" class="breathe"/>'
    + node(410, 74, 150, 30, "/api/orders", size=11)
    + node(410, 122, 150, 30, "/api/pay", hot=True, size=11) + tag(518, 114)
    + '<rect x="410" y="170" width="150" height="30" rx="6" fill="#0B0C0E" stroke="#E0101A" stroke-width="1.5" stroke-dasharray="4 3"/>'
    + text(422, 189, "Order", 11, "#C9CDD3", "m", 700)
    + text(410, 236, "+ paid_at  12s ago", 11, "#5E636B", "m", 700, 0.6)
)
card("card-changes.svg", "CHANGES", "What the agent did",
     ["New parts glow red, changed", "ones get a dashed edge.", "Since the session started."],
     changes_art, "Changes: new parts glow red, changed parts get a dashed edge, everything since the session started.")

live_path1 = "M410 100 C460 100 480 150 560 150"
live_path2 = "M410 200 C460 200 480 150 560 150"
live_art = (
    f'<path class="flow" d="{live_path1}" stroke="#2A2C31" fill="none" stroke-width="1.4"/>'
    f'<path class="flow" d="{live_path2}" stroke="#2A2C31" fill="none" stroke-width="1.4"/>'
    + dots(live_path1, "#C9CDD3", 2, 1.6) + dots(live_path2, "#FF2A2A", 1, 1.6, 0.4)
    + '<circle cx="410" cy="100" r="5" fill="#0B0C0E" stroke="#4A4E55" stroke-width="1.5"/>'
    + '<circle cx="410" cy="200" r="5" fill="#0B0C0E" stroke="#4A4E55" stroke-width="1.5"/>'
    + '<circle cx="560" cy="150" r="6" fill="#0B0C0E" stroke="#C9CDD3" stroke-width="1.5"/>'
    + text(404, 236, "200  41ms", 11, "#9EA4AD", "m", 700, 0.6)
    + text(492, 236, "500", 11, "#FF2A2A", "m", 700, 0.6)
)
card("card-live.svg", "LIVE", "Does it work",
     ["Real requests travel the map,", "matched to the code that serves", "them. Errors turn red."],
     live_art, "Live: real requests travel the map, matched to the code that serves them, and errors turn red.")

mcp_art = (
    '<rect x="396" y="70" width="180" height="150" rx="10" fill="#0B0C0E" stroke="#2A2C31" stroke-width="1.3"/>'
    + '<circle cx="412" cy="86" r="3" fill="#34363B"/><circle cx="424" cy="86" r="3" fill="#34363B"/><circle cx="436" cy="86" r="3" fill="#34363B"/>'
    + text(410, 116, "› trace", 11.5, "#C9CDD3", "m", 700)
    + text(410, 134, "  /api/orders/", 11.5, "#9EA4AD", "m", 500)
    + text(410, 158, "view  views.py:7", 11, "#5E636B", "m", 500)
    + text(410, 176, "uses  Order", 11, "#5E636B", "m", 500)
    + text(410, 194, "from  /cart", 11, "#5E636B", "m", 500)
    + '<rect x="410" y="202" width="8" height="12" fill="#FF2A2A" class="breathe"/>'
)
card("card-mcp.svg", "MCP", "Your agent sees it",
     ["Claude Code, Codex and Cursor", "ask the map before they touch", "the code."],
     mcp_art, "MCP: Claude Code, Codex and Cursor ask the map before they touch the code.")


# ── agents strip (1200 × 120) ────────────────────────────────────────────────

agents = [("CLAUDE CODE", True), ("CODEX", True), ("CLAUDE DESKTOP", False), ("CURSOR", False)]
body = frame(1200, 120, 14)
x = 36
for name, tested in agents:
    w = 64 + len(name) * 10.6
    body += f'<rect x="{x}" y="34" width="{w:.0f}" height="52" rx="10" fill="#0B0C0E" stroke="#3E4248" stroke-width="1.3"/>'
    dot = "#FF2A2A" if tested else "#3E4248"
    glow = ' filter="url(#glow)"' if tested else ""
    body += f'<circle cx="{x + 24}" cy="60" r="4" fill="{dot}"{glow}/>'
    body += text(x + 40, 65, name, 15, "#F2F3F5" if tested else "#9A9FA7", "m", 700, 1.6)
    x += w + 18
body += text(1164, 54, "● TESTED", 11, "#FF2A2A", "m", 700, 1.6, "end")
body += text(1164, 76, "● SAME CONFIG", 11, "#5E636B", "m", 700, 1.6, "end")
svg("agents.svg", 1200, 120, "Works with Claude Code and Codex (tested), Claude Desktop and Cursor (same MCP config).", body, bp=560)


# ── traffic card (1200 × 200) ────────────────────────────────────────────────

body = frame(1200, 200, 14)
cols = [("DJANGO", "sdk/django_middleware.py", "one line in MIDDLEWARE"),
        ("REACT · RN", "sdk/telemetry_client.js", "initTraceFlow() at startup"),
        ("ANYTHING", "POST /api/ingest", "JSON: path, method, status")]
for i, (k, f, d) in enumerate(cols):
    cx = 36 + i * 384
    body += text(cx, 58, k, 12, "#5E636B", "m", 700, 2.4)
    body += text(cx, 100, f, 19, "#F2F3F5", "m", 700)
    body += text(cx, 132, d, 16, "#9A9FA7")
    if i:
        body += f'<rect x="{cx - 24}" y="40" width="1" height="120" fill="#1C1E21"/>'
body += text(36, 176, "no dependencies  ·  sends in the background  ·  silent when the map is off", 12, "#5E636B", "m", 700, 1.2)
svg("traffic.svg", 1200, 200, "Live traffic: copy the Django middleware or the React fetch wrapper from sdk/, or POST JSON to /api/ingest. No dependencies, sends in the background.", body, bp=560)


# ── how it works (1200 × 260) ────────────────────────────────────────────────

body = frame(1200, 300, 14)
boxes = [
    (36, 70, 200, "YOUR CODE", "Django · React · RN", False),
    (286, 70, 200, "PARSER", "ast · read-only", False),
    (536, 70, 220, "CORE", "watch · diff · traffic", True),
    (836, 40, 328, "MAP", "localhost:4317", False),
    (836, 140, 328, "MCP", "Claude · Codex · Cursor", False),
    (286, 170, 200, "SDK", "middleware · fetch", False),
]
paths = [
    ("M236 105 L286 105", "#C9CDD3"), ("M486 105 L536 105", "#C9CDD3"),
    ("M756 95 C796 95 796 75 836 75", "#C9CDD3"), ("M756 115 C796 115 796 175 836 175", "#FF2A2A"),
    ("M486 205 C516 205 516 125 536 125", "#FF2A2A"),
]
for d, c in paths:
    body += f'<path class="flow" d="{d}" stroke="#2A2C31" fill="none" stroke-width="1.5"/>' + dots(d, c, 1, 1.6)
for x, y, w, k, sub, hot in boxes:
    stroke = "#FF2A2A" if hot else "#4A4E55"
    cls = ' class="breathe"' if hot else ""
    body += f'<rect x="{x}" y="{y}" width="{w}" height="70" rx="10" fill="#0B0C0E" stroke="{stroke}" stroke-width="1.5"{cls}/>'
    body += text(x + 20, y + 30, k, 13, "#F2F3F5", "m", 700, 2.4)
    body += text(x + 20, y + 53, sub, 14, "#9A9FA7")
body += text(36, 276, "local only  ·  no accounts  ·  no AI calls of its own  ·  never writes to your project", 12, "#5E636B", "m", 700, 1.2)
svg("how.svg", 1200, 300, "How it works: the read-only parser reads your code, the core watches files, computes the diff and collects traffic from the SDKs, and serves the live map and the MCP tools.", body, bp=560)


# ── buttons (260 × 56) ───────────────────────────────────────────────────────

def button(name, label, glyph):
    body = frame(260, 56, 12)
    body += glyph
    body += text(70, 34, label, 13.5, "#C9CDD3", "m", 700, 2.4)
    body += text(232, 34, "↗", 14, "#5E636B", "m", 700, None, "end")
    svg(name, 260, 56, label, body)


button("btn-npm.svg", "NPM", '<rect x="26" y="15" width="26" height="26" rx="5" fill="none" stroke="#C9CDD3" stroke-width="1.8"/>'
       + text(39, 33, "n", 15, "#C9CDD3", "s", 800, None, "middle"))
button("btn-sponsor.svg", "SPONSOR", '<path d="M39 40 C30 33 25 28 25 22 a6 6 0 0 1 14 -3 a6 6 0 0 1 14 3 c0 6 -5 11 -14 18z" fill="none" stroke="#FF2A2A" stroke-width="1.8"/>')
button("btn-patreon.svg", "PATREON", '<circle cx="42" cy="24" r="8" fill="none" stroke="#C9CDD3" stroke-width="1.8"/><rect x="27" y="16" width="3" height="24" fill="#C9CDD3"/>')

print(f"wrote {len(list(OUT.glob('*.svg')))} files to {OUT}")
