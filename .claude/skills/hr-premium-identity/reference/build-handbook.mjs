// Builds the Talent Acquisition new-starter handbook as HTML in the Sato house identity
// (the three logo blues, lines and type only, no filled areas), then Chrome prints it.
// Usage: node build-handbook.mjs <handbookDir> <repoRoot>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const [dir, repo] = process.argv.slice(2);
const sharp = createRequire(join(repo, "package.json"))("sharp");

const C = {
  ink: "#000000",
  deep: "#0A527D",
  blue: "#0A6BA6",
  light: "#1482C2",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
};

const enc = (svg) => svg.replace(/\s+/g, " ").replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C")
  .replace(/>/g, "%3E").replace(/"/g, "%22").replace(/'/g, "%27").replace(/ /g, "%20");
const svgUri = (svg) => `data:image/svg+xml,${enc(svg)}`;
const n = (v) => Number(v.toFixed(3));

// The house engine-turned band, the same geometry as houseEngineTurnedBand() in house-identity.ts:
// a 6 x 1.5 mm wave tile, centred and repeated across the 176 mm column. Drawn as one inline vector
// (not a CSS background tile, which Chrome rasterises into the PDF and prints soft).
function band(color = C.deep) {
  const w = 6, h = 1.5, stroke = 0.26, mid = h / 2, width = 176;
  const amp = (mid - stroke) * (4 / 3);
  const x0 = ((width / 2 - w / 2) % w) - w;
  let up = "", down = "";
  for (let x = x0; x < width; x += w) {
    up += `M${n(x)} ${mid}Q${n(x + w / 4)} ${n(mid - amp)} ${n(x + w / 2)} ${mid}T${n(x + w)} ${mid}`;
    down += `M${n(x)} ${mid}Q${n(x + w / 4)} ${n(mid + amp)} ${n(x + w / 2)} ${mid}T${n(x + w)} ${mid}`;
  }
  return `<svg class="band" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" preserveAspectRatio="none">` +
    `<g fill="none" stroke="${color}" stroke-width="${stroke}"><path d="${up}"/><path d="${down}"/></g></svg>`;
}

// The page frame, drawn in millimetres over the whole sheet: a deep keyline, a light one inside
// it, a line of security microtext running between them, and a square tile at each corner.
// The closing page passes its own inks (gold on navy); every other page keeps the house blues.
const HOUSE_FRAME = { outer: C.deep, inner: C.light, text: C.blue, tile: "#fff", tileLine: C.deep, tileInner: C.light, pip: C.deep };
function frame(p = HOUSE_FRAME) {
  const W = 210, H = 297, o = 6, i = 8.8, mid = (o + i) / 2, tile = 5.2;
  const fs = 1.12, half = fs * 0.36;
  const start = mid + tile / 2 + 1.6;
  const phrase = "SATO PHARMA · NEW STARTER HANDBOOK · HUMAN RESOURCES · HEAD OFFICE · TALENT ACQUISITION · ";
  const run = (len) => {
    const reps = Math.max(1, Math.round((0.86 * len) / (phrase.length * 0.6 * fs)));
    return phrase.repeat(reps).replace(/ · $/, "");
  };
  const text = (len, attrs) =>
    `<text ${attrs} textLength="${n(len)}" lengthAdjust="spacing">${run(len)}</text>`;
  const across = W - 2 * start, down = H - 2 * start;
  const corner = (cx, cy) => {
    const a = tile / 2, b = a - 1.15, c = 0.55;
    return `<rect x="${n(cx - a)}" y="${n(cy - a)}" width="${tile}" height="${tile}" fill="${p.tile}" stroke="${p.tileLine}" stroke-width="0.25"/>` +
      `<rect x="${n(cx - b)}" y="${n(cy - b)}" width="${n(2 * b)}" height="${n(2 * b)}" fill="none" stroke="${p.tileInner}" stroke-width="0.1"/>` +
      `<rect x="${n(cx - c)}" y="${n(cy - c)}" width="${2 * c}" height="${2 * c}" fill="${p.pip}" transform="rotate(45 ${n(cx)} ${n(cy)})"/>`;
  };
  return `<svg class="frame" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<rect x="${o}" y="${o}" width="${W - 2 * o}" height="${H - 2 * o}" fill="none" stroke="${p.outer}" stroke-width="0.26"/>` +
    `<rect x="${i}" y="${i}" width="${n(W - 2 * i)}" height="${n(H - 2 * i)}" fill="none" stroke="${p.inner}" stroke-width="0.09"/>` +
    `<g fill="${p.text}" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="${fs}">` +
    text(across, `x="${n(start)}" y="${n(mid + half)}"`) +
    text(across, `x="${n(start)}" y="${n(H - mid + half)}"`) +
    text(down, `transform="translate(${n(mid + half)} ${n(H - start)}) rotate(-90)"`) +
    text(down, `transform="translate(${n(W - mid - half)} ${n(start)}) rotate(90)"`) +
    `</g>` +
    corner(mid, mid) + corner(W - mid, mid) + corner(mid, H - mid) + corner(W - mid, H - mid) +
    `</svg>`;
}

// An engraved block behind the portrait: drifting wave hairlines, the band's wave set as a
// lathe field. Line only, so it prints as a fine tone rather than a filled area.
function engraving(w, h, ink = C.light, weight = 0.06) {
  const gap = 0.62, amp = 0.24, wave = 4, lines = [];
  for (let k = 0; k * gap <= h; k++) {
    const y = k * gap, shift = (k * wave) / 22;
    let d = `M${n(-wave - shift)} ${n(y)}`;
    for (let x = -wave - shift; x < w + wave; x += wave) {
      d += `Q${n(x + wave / 4)} ${n(y - amp)} ${n(x + wave / 2)} ${n(y)}Q${n(x + (3 * wave) / 4)} ${n(y + amp)} ${n(x + wave)} ${n(y)}`;
    }
    lines.push(`<path d="${d}"/>`);
  }
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<g fill="none" stroke="${ink}" stroke-width="${weight}">${lines.join("")}</g></svg>`);
}

// The closing page's inks: night navy and gold. The ink rule (no filled areas) is set aside on
// this one page at the owner's request; every other page keeps it.
const G = {
  navy: "#0A1B2E", panel: "#0C2136", gold: "#C9A45C", light: "#E4CC8E", deep: "#A8843F",
  text: "#F1F4F8", soft: "#C5CFDA", muted: "#8B9BAE", hair: "#22344A", ghair: "#4F4B3C",
};
const GOLD_FRAME = { outer: G.gold, inner: G.deep, text: G.deep, tile: G.navy, tileLine: G.gold, tileInner: G.deep, pip: G.gold };

// The seal's engine-turned field: wavy concentric diamonds. It goes into the page as a fine image,
// not as vector hairlines: a screen PDF viewer draws every line at least one pixel wide, so a field of
// 0.07 mm lines turns into solid gold stripes on screen, while an image is averaged down smoothly.
function sealFieldSvg() {
  const wavy = (r, phase) => {
    const corners = [[0, -r], [r, 0], [0, r], [-r, 0]], steps = 56, amp = 0.42, waves = 9;
    let d = "";
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = corners[e], [bx, by] = corners[(e + 1) % 4];
      const len = Math.hypot(bx - ax, by - ay), nx = (by - ay) / len, ny = -(bx - ax) / len;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, off = Math.sin(t * Math.PI) * amp * Math.sin(2 * Math.PI * waves * t + phase);
        const x = ax + (bx - ax) * t + nx * off, y = ay + (by - ay) * t + ny * off;
        d += `${e === 0 && s === 0 ? "M" : "L"}${n(x)} ${n(y)}`;
      }
    }
    return `<path d="${d}Z"/>`;
  };
  const field = [];
  for (let k = 0, r = 40.6; r > 25.5; k++, r -= 0.78) field.push(wavy(r, k * 0.55));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000" viewBox="-51 -51 102 102">` +
    `<g fill="none" stroke="${G.gold}" stroke-width=".13" opacity=".9">${field.join("")}</g></svg>`;
}
const sealField = `data:image/png;base64,${(await sharp(Buffer.from(sealFieldSvg())).png({ compressionLevel: 9 }).toBuffer()).toString("base64")}`;

// A diamond seal for Part Two: keylines, a ring of microtext along its four edges, the
// engine-turned field, and a plain window for the Phoenix emblem.
function diamondSeal() {
  const dia = (r) => `M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`;
  const edge = (id, [ax, ay], [bx, by], label) =>
    `<path id="${id}" d="M${ax} ${ay}L${bx} ${by}" fill="none"/>` +
    `<text><textPath href="#${id}" startOffset="50%" text-anchor="middle">${label}</textPath></text>`;
  const ri = 43.7, ro = 46.3;
  return `<svg viewBox="-51 -51 102 102" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${dia(50)}" fill="${G.navy}" stroke="${G.gold}" stroke-width=".55"/>` +
    `<path d="${dia(48.4)}" fill="none" stroke="${G.deep}" stroke-width=".2"/>` +
    `<path d="${dia(41.6)}" fill="none" stroke="${G.gold}" stroke-width=".35"/>` +
    `<g fill="${G.light}" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="2.55" letter-spacing=".62">` +
    edge("sl1", [-ri, 0], [0, -ri], "PHOENIX WORKFORCE") + edge("sl2", [0, -ri], [ri, 0], "PART TWO") +
    edge("sl3", [-ro, 0], [0, ro], "SATO PHARMA") + edge("sl4", [0, ro], [ro, 0], "YOUR ACCOUNT") + `</g>` +
    [[0, -45], [45, 0], [0, 45], [-45, 0]].map(([x, y]) => `<rect x="${x - 0.75}" y="${y - 0.75}" width="1.5" height="1.5" fill="${G.gold}" transform="rotate(45 ${x} ${y})"/>`).join("") +
    `<image href="${sealField}" x="-51" y="-51" width="102" height="102"/>` +
    `<path d="${dia(24.6)}" fill="${G.navy}" stroke="${G.gold}" stroke-width=".45"/>` +
    `<path d="${dia(23.2)}" fill="none" stroke="${G.deep}" stroke-width=".15"/>` +
    `</svg>`;
}

const dataUri = (path, mime) => `data:${mime};base64,${readFileSync(path).toString("base64")}`;
const asset = (f, mime = "image/png") => dataUri(join(dir, "assets", f), mime);
const logo = dataUri(join(repo, "public/brand/sato-pharma-logo-on-light.svg"), "image/svg+xml");
const arabic = asset("sato-pharma-arabic-on-light.png");
const phoenix = asset("phoenix-login-emblem.png");
const portrait = asset("yomna-portrait.jpg", "image/jpeg");
const logoReverse = asset("sato-pharma-reverse.png");
const arabicGold = asset("sato-pharma-arabic-gold.png");
// The signature joins the closing page once its clean vector exists; until then the name is set as type.
const SIGNATURE_SVG = "C:/Users/satoh/Downloads/New folder (5)/omar-gawish-signature.svg";
const signature = existsSync(SIGNATURE_SVG)
  ? `<span class="sig">${readFileSync(SIGNATURE_SVG, "utf8").replace(/<\?xml[^>]*>/, "").replace(/<svg/, '<svg aria-label="Omar Gawish signature"')}</span>`
  : "";

const css = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; border-radius: 0 !important; }
  :root, html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: ${C.body};
    font-family: "Segoe UI Variable Text", "Segoe UI", Tahoma, Arial, sans-serif;
    font-kerning: normal; text-rendering: geometricPrecision; }
  p { text-wrap: pretty; hyphens: none; }

  .page { position: relative; width: 210mm; height: 297mm; padding: 15.5mm 17mm 0 17mm;
    overflow: hidden; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .frame { position: absolute; inset: 0; width: 210mm; height: 297mm; pointer-events: none; z-index: 2; }

  /* the Arabic calligraphy as a watermark: one ink, very faint, laid inside the frame */
  .watermark { position: absolute; right: 11mm; bottom: 21mm; width: 112mm; opacity: .05; }

  /* masthead: the two Sato marks, Latin left, Arabic right */
  .mast { position: relative; display: grid; grid-template-columns: 34mm 1fr 28mm; align-items: center; column-gap: 6mm; }
  .mast .latin { display: block; width: 34mm; height: auto; }
  .mast .arabic { display: block; width: 28mm; height: auto; justify-self: end; }
  .mast .mid { text-align: center; }
  .mast .mid .t { color: ${C.deep}; font-size: 8.5pt; font-weight: 700; letter-spacing: 2.6pt; text-transform: uppercase; }
  .mast .mid .rule { display: flex; justify-content: center; align-items: center; gap: 1.6mm; margin: 1.6mm 0 1.4mm; }
  .mast .mid .rule i { display: block; width: 9mm; border-top: .4pt solid ${C.hair}; }
  .mast .mid .rule b { display: block; width: 1.3mm; height: 1.3mm; border: .5pt solid ${C.light}; transform: rotate(45deg); }
  .mast .mid .s { color: ${C.muted}; font-size: 6.8pt; letter-spacing: 1.3pt; text-transform: uppercase; }
  .band { display: block; width: 100%; height: 1.5mm; margin-top: 3.5mm; overflow: hidden; }

  .micro { font-size: 7pt; font-weight: 700; letter-spacing: 1.6pt; text-transform: uppercase; }
  .eyebrow { color: ${C.blue}; }

  /* hero */
  .hero { position: relative; display: grid; grid-template-columns: 1fr 70mm; column-gap: 11mm; margin-top: 7.5mm; }
  .chapter { display: flex; align-items: flex-end; gap: 3.5mm; }
  .chapter .num { font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 58pt; line-height: .74;
    font-weight: 200; color: transparent; -webkit-text-stroke: .6pt ${C.light}; letter-spacing: -1.5pt; }
  .chapter .lbl { flex: 1; display: flex; align-items: center; gap: 2.5mm; padding-bottom: 1.2mm; }
  .chapter .lbl::after { content: ""; flex: 1; border-top: .5pt solid ${C.hair}; }
  .hero h1 { margin: 6.5mm 0 0; color: ${C.deep}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 29pt; line-height: 1.08; font-weight: 250; letter-spacing: -0.6pt; }
  .hero h1 b { display: block; margin-top: 1mm; font-size: 50pt; line-height: .98; font-weight: 700; letter-spacing: -1.6pt; color: ${C.deep}; }
  .tick { display: flex; align-items: center; gap: 1.5mm; margin: 5mm 0 4.5mm; }
  .tick i { display: block; border-top: 1.2pt solid ${C.blue}; width: 14mm; }
  .tick i + i { width: 3mm; border-top-color: ${C.light}; }
  .tick i + i + i { width: 1.2mm; border-top-color: ${C.hair}; }
  .lead { margin: 0; font-size: 11.2pt; line-height: 1.55; color: ${C.body}; }

  .facts { margin: 6mm 0 0; padding: 0; border-top: .7pt solid ${C.deep}; }
  .facts div { display: grid; grid-template-columns: 25mm 1fr; column-gap: 4mm;
    padding: 2.2mm 0; border-bottom: .4pt solid ${C.hair}; align-items: baseline; }
  .facts dt { color: ${C.blue}; font-size: 6.4pt; font-weight: 700; letter-spacing: 1.3pt; text-transform: uppercase; }
  .facts dd { margin: 0; font-size: 10pt; color: ${C.ink}; font-variant-numeric: lining-nums; }

  /* portrait: the photograph over an engraved block, with square corner marks */
  .portrait { position: relative; width: 70mm; margin: 2mm 0 0; }
  .portrait .engrave { position: absolute; left: 5mm; top: 5mm; width: 65mm; height: 88mm;
    background: url("${engraving(65, 88)}") 0 0 / 65mm 88mm no-repeat; }
  .portrait .engrave::after { content: ""; position: absolute; inset: 0; border: .4pt solid ${C.light}; }
  .portrait .photo { position: relative; width: 65mm; height: 88mm; background: #fff; outline: 1.4mm solid #fff; }
  .portrait .photo img { display: block; width: 65mm; height: 88mm; object-fit: cover; }
  .portrait .photo .c { position: absolute; width: 5mm; height: 5mm; border-color: ${C.deep}; border-style: solid; border-width: 0; }
  .portrait .photo .c.tl { left: -2.6mm; top: -2.6mm; border-left-width: .9pt; border-top-width: .9pt; }
  .portrait .photo .c.br { right: -7.6mm; bottom: -7.6mm; border-right-width: .9pt; border-bottom-width: .9pt; }
  .portrait .cap { margin-top: 11mm; display: grid; grid-template-columns: auto 1fr; column-gap: 3mm; align-items: center; }
  .portrait .cap .bar { width: 1.2pt; align-self: stretch; background: ${C.blue}; }
  .portrait .cap .name { display: block; color: ${C.deep}; font-size: 11pt; font-weight: 700; letter-spacing: 1.8pt; }
  .portrait .cap .role { display: block; margin-top: .7mm; color: ${C.muted}; font-size: 6.6pt; letter-spacing: 1.5pt; }

  /* the note */
  .note { position: relative; margin-top: 8mm; }
  .note .head { display: flex; align-items: center; gap: 4mm; color: ${C.blue}; }
  .note .head::after { content: ""; flex: 1; border-top: .5pt solid ${C.hair}; }
  .note .body { margin-top: 4.5mm; column-count: 2; column-gap: 10mm; column-rule: .3pt solid ${C.hair};
    font-size: 9.8pt; line-height: 1.6; }
  .note .body p { margin: 0 0 2.6mm; }
  .note .quote { position: absolute; left: -6.6mm; top: 7mm; color: ${C.light}; font-family: Georgia, serif;
    font-size: 34pt; line-height: 1; }
  .sign { break-inside: avoid; margin-top: 4mm; }
  .sign .close { margin: 0 0 3mm; }
  .sign .rule { display: block; width: 10mm; border-top: 1.2pt solid ${C.blue}; margin-bottom: 2.2mm; }
  .sign .who { color: ${C.deep}; font-weight: 700; font-size: 10.5pt; letter-spacing: .2pt; }
  .sign .what { margin-top: .4mm; color: ${C.muted}; font-size: 8pt; }

  /* running foot: Sato at the top of the page, Phoenix at the bottom */
  .foot { position: absolute; left: 17mm; right: 17mm; bottom: 12.5mm; display: grid;
    grid-template-columns: 1fr auto 1fr; align-items: center; padding-top: 2.5mm;
    border-top: .5pt solid ${C.hair}; color: ${C.muted}; font-size: 6.8pt; }
  .foot .ph { display: flex; align-items: center; gap: 2mm; }
  .foot .ph img { width: 6.5mm; height: 6.5mm; }
  .foot .ph span { letter-spacing: 1pt; text-transform: uppercase; font-weight: 700; color: ${C.deep}; font-size: 6.4pt; }
  .foot .code { text-align: center; letter-spacing: .6pt; }
  .foot .num { justify-self: end; display: flex; align-items: baseline; gap: 2mm; }
  .foot .num span { letter-spacing: 1pt; text-transform: uppercase; font-size: 6.2pt; }
  .foot .num b { color: ${C.deep}; font-size: 9pt; letter-spacing: 1pt; }

  /* section head: a micro label with a hairline running out to the column edge */
  .shead { display: flex; align-items: center; gap: 4mm; color: ${C.blue}; }
  .shead::after { content: ""; flex: 1; border-top: .5pt solid ${C.hair}; }
  .shead .k { color: ${C.light}; font-weight: 600; }

  /* page 2 — about Sato Pharma */
  .about-hero { display: grid; grid-template-columns: 1fr 104mm; column-gap: 8mm; margin-top: 5mm; align-items: end; }
  .about-hero h1 { margin: 0; color: ${C.deep}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 25pt; line-height: 1.08; font-weight: 250; letter-spacing: -0.6pt; }
  .about-hero h1 b { display: block; margin-top: .5mm; font-size: 37pt; line-height: 1; font-weight: 700; letter-spacing: -1.3pt; }
  .about-hero .lead { margin: 0; padding-left: 4.5mm; border-left: .5pt solid ${C.hair}; font-size: 9.8pt; line-height: 1.55; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 5.5mm; border-top: .7pt solid ${C.deep}; border-bottom: .4pt solid ${C.hair}; }
  .stats div { padding: 2.4mm 4mm 2.2mm; border-left: .4pt solid ${C.hair}; }
  .stats div:first-child { padding-left: 0; border-left: 0; }
  .stats b { display: block; color: ${C.deep}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 22pt; line-height: 1; font-weight: 300; letter-spacing: -0.8pt; font-variant-numeric: lining-nums; }
  .stats b sup { font-size: 14pt; color: ${C.light}; font-weight: 400; vertical-align: 8pt; margin-left: .4mm; }
  .stats span { display: block; margin-top: 1.6mm; color: ${C.muted}; font-size: 6.2pt; font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; }
  .stats em { display: block; margin-top: .9mm; font-style: normal; color: ${C.blue}; font-size: 7.2pt; font-weight: 600; letter-spacing: .2pt; }

  .name { margin-top: 5mm; }
  .letters { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 3.5mm; }
  .letters div { position: relative; padding: 0 0 0 4mm; border-left: .4pt solid ${C.hair}; }
  .letters div:first-child { padding-left: 0; border-left: 0; }
  .letters .L { display: block; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 40pt; line-height: .8;
    font-weight: 200; color: transparent; -webkit-text-stroke: .6pt ${C.light}; }
  .letters .on .L { color: ${C.deep}; -webkit-text-stroke: 0; font-weight: 700; }
  .letters .w { display: block; margin-top: 2.2mm; color: ${C.deep}; font-size: 8.2pt; font-weight: 700; letter-spacing: 2.2pt; text-transform: uppercase; }
  .letters .on .w { color: ${C.blue}; }
  .motto { display: grid; grid-template-columns: 1fr 1fr; column-gap: 10mm; align-items: center; margin-top: 3.5mm; padding-top: 3mm; border-top: .4pt solid ${C.hair}; }
  .motto .say { margin: 0; color: ${C.deep}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 14pt; line-height: 1.25; font-weight: 300; letter-spacing: -0.2pt; }
  .motto .say b { font-weight: 700; }
  .motto .yours { margin: 0; padding-left: 4mm; border-left: 1.2pt solid ${C.blue}; font-size: 9.6pt; line-height: 1.52; }

  .mv { display: grid; grid-template-columns: 1fr 1fr; column-gap: 10mm; margin-top: 4.6mm; }
  .mv .col { border-top: .7pt solid ${C.deep}; padding-top: 2.8mm; }
  .mv .col .k { display: flex; align-items: baseline; gap: 2.5mm; color: ${C.blue}; }
  .mv .col .k i { font-style: normal; color: ${C.light}; font-weight: 600; letter-spacing: .6pt; }
  .mv .col p { margin: 1.8mm 0 0; font-size: 9.1pt; line-height: 1.5; }

  .values { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 3.2mm; }
  .values div { padding: 0 4mm; border-left: .4pt solid ${C.hair}; }
  .values div:first-child { padding-left: 0; border-left: 0; }
  .values div:last-child { padding-right: 0; }
  .values i { display: inline-block; margin-right: 2mm; vertical-align: 1pt; font-style: normal; color: ${C.light}; font-size: 7pt; font-weight: 600; letter-spacing: 1pt; }
  .values b { display: block; margin-top: 0; color: ${C.deep}; font-size: 9.8pt; font-weight: 700; white-space: nowrap; }
  .values span { display: block; margin-top: 1mm; font-size: 8.4pt; line-height: 1.45; color: ${C.body}; }

  .shelf { margin-top: 4.4mm; }
  .packs { display: grid; grid-template-columns: repeat(11, 1fr); column-gap: 1.6mm; align-items: end; margin-top: 3.5mm;
    padding-bottom: 2.4mm; border-bottom: .7pt solid ${C.deep}; }
  .packs img { display: block; width: 100%; height: 14mm; object-fit: contain; object-position: center bottom; }
  .packs + .cap { display: flex; justify-content: space-between; gap: 6mm; margin-top: 1.8mm; color: ${C.muted}; font-size: 7.2pt; }
  .packs + .cap b { color: ${C.deep}; font-weight: 700; }

  /* page 3 — purpose of the handbook */
  .purpose-hero { grid-template-columns: 1fr 98mm; }
  .outline-n { font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-weight: 200; color: transparent;
    -webkit-text-stroke: .6pt ${C.light}; letter-spacing: -0.5pt; font-variant-numeric: lining-nums; }

  .route-wrap { margin-top: 7mm; }
  .route { position: relative; display: grid; grid-template-columns: repeat(8, 1fr); margin-top: 4mm; }
  .route::before { content: ""; position: absolute; left: 1.2mm; right: 0; top: 10.6mm; border-top: .5pt solid ${C.hair}; }
  .route div { position: relative; padding-right: 2.5mm; }
  .route .n { display: block; height: 8mm; font-size: 21pt; line-height: 1; }
  .route .dot { display: block; position: relative; width: 2.2mm; height: 2.2mm; margin: 1.5mm 0 0 .1mm;
    border: .6pt solid ${C.deep}; background: #fff; transform: rotate(45deg); }
  .route .t { display: block; margin-top: 2.6mm; color: ${C.deep}; font-size: 7.6pt; line-height: 1.32; font-weight: 600; }
  .route .here .n { color: ${C.deep}; -webkit-text-stroke: 0; font-weight: 700; }
  .route .here .dot { background: ${C.deep}; outline: .4pt solid ${C.light}; outline-offset: .7mm; }
  .route .here .t { color: ${C.blue}; }
  .route .here .t em { display: block; margin-top: 1mm; font-style: normal; color: ${C.light}; font-size: 5.8pt;
    font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; }

  .aims-wrap { margin-top: 6mm; }
  .aims { display: grid; grid-template-columns: 1fr 1fr; column-gap: 10mm; margin-top: 3.5mm; }
  .aims div { display: grid; grid-template-columns: 12mm 1fr; padding: 3.2mm 0 3.4mm; border-top: .4pt solid ${C.hair}; }
  .aims div:nth-child(-n+2) { border-top: 0; padding-top: 1.2mm; }
  .aims .n { margin: 0; font-size: 22pt; line-height: .9; }
  .aims b { display: block; color: ${C.deep}; font-size: 10.2pt; font-weight: 700; }
  .aims span { display: block; margin-top: 1.1mm; font-size: 8.9pt; line-height: 1.5; }

  .steps-wrap { margin-top: 5.5mm; }
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 3.5mm; }
  .steps div { padding: 0 5mm; border-left: .4pt solid ${C.hair}; }
  .steps div:first-child { padding-left: 0; border-left: 0; }
  .steps div:last-child { padding-right: 0; }
  .steps .n { display: block; margin: 0; font-size: 26pt; line-height: .8; }
  .steps b { display: block; margin-top: 2.6mm; color: ${C.deep}; font-size: 10.2pt; font-weight: 700; }
  .steps span { display: block; margin-top: 1.1mm; font-size: 8.9pt; line-height: 1.5; text-wrap: pretty; }

  .closing { display: grid; grid-template-columns: 1fr 1fr; column-gap: 10mm; margin-top: 6.5mm;
    padding-top: 4mm; border-top: .7pt solid ${C.deep}; }
  .closing > div { padding-left: 4mm; border-left: 1.2pt solid ${C.blue}; }
  .closing > div + div { border-left: .5pt solid ${C.hair}; }
  .closing .h { color: ${C.blue}; }
  .closing p { margin: 1.6mm 0 0; font-size: 9pt; line-height: 1.52; }

  /* page 4 — the Head Office team */
  .team-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); column-gap: 4mm; margin-top: 4.6mm; }
  .team-row + .team-row { margin-top: 3.6mm; }
  .grp { grid-column: span var(--n); min-width: 0; }
  .ghead { position: relative; padding-bottom: 1.5mm; border-bottom: .5pt solid ${C.hair}; color: ${C.blue};
    font-size: 6pt; letter-spacing: .9pt; white-space: nowrap; }
  .ghead::after { content: ""; position: absolute; left: 0; bottom: -.5pt; width: 7mm; border-bottom: 1.3pt solid ${C.blue}; }
  .gpeople { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); column-gap: 4mm; margin-top: 3.2mm; }
  .person { margin: 0; min-width: 0; }
  .person .ph { position: relative; aspect-ratio: 3 / 4; background: #fff; outline: .4pt solid ${C.hair}; outline-offset: .8mm; }
  .person .ph img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .person .ph.none { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2mm;
    background: url("${engraving(26, 35)}") 0 0 / 100% 100% no-repeat; }
  .person .ph.none .outline-n { font-size: 30pt; line-height: 1; -webkit-text-stroke: .7pt ${C.deep}; background: #fff; padding: 0 1.5mm; }
  .person .ph.none .micro { font-style: normal; color: ${C.blue}; font-size: 5.4pt; letter-spacing: 1pt; background: #fff; padding: .4mm 1mm; }
  .person figcaption { margin-top: 2.6mm; }
  .person b { display: block; color: ${C.deep}; font-size: 8.2pt; line-height: 1.22; font-weight: 700; }
  .person span { display: block; margin-top: .6mm; color: ${C.muted}; font-size: 7.1pt; line-height: 1.3; }
  .person em { display: inline-block; margin-top: 1.2mm; padding-top: .8mm; border-top: .8pt solid ${C.blue}; font-style: normal;
    color: ${C.blue}; font-size: 5.8pt; font-weight: 700; letter-spacing: .9pt; text-transform: uppercase; }
  .lead-row .person .ph { outline-color: ${C.light}; }

  /* page 5 — the job description */
  .rolefacts { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1.1fr; margin: 5mm 0 0; border-top: .7pt solid ${C.deep};
    border-bottom: .4pt solid ${C.hair}; }
  .rolefacts div { padding: 2.6mm 4mm 2.8mm; border-left: .4pt solid ${C.hair}; }
  .rolefacts div:first-child { padding-left: 0; border-left: 0; }
  .rolefacts div:last-child { padding-right: 0; }
  .rolefacts dt { color: ${C.blue}; font-size: 6.2pt; font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; }
  .rolefacts dd { margin: 1.3mm 0 0; color: ${C.ink}; font-size: 9.4pt; font-weight: 600; line-height: 1.35; }
  .rolefacts dd small { display: block; margin-top: .5mm; color: ${C.muted}; font-size: 7.6pt; font-weight: 400; }

  .duties-wrap { margin-top: 4mm; }
  .duties { display: grid; grid-template-columns: 1fr 1fr; column-gap: 9mm; margin-top: 1mm; }
  .duties div { display: grid; grid-template-columns: 9mm 1fr; padding: 1.3mm 0 1.4mm; border-bottom: .4pt solid ${C.hair}; align-items: center; }
  .duties .n { font-size: 15pt; line-height: 1; }
  .duties b { display: block; color: ${C.deep}; font-size: 9.4pt; font-weight: 700; }
  .duties span:not(.n) { display: block; margin-top: .5mm; font-size: 8.5pt; line-height: 1.4; }

  .hire-wrap { margin-top: 4mm; }
  .hire { position: relative; display: grid; grid-template-columns: repeat(8, 1fr); margin: 3mm 0 0; padding: 0; list-style: none; }
  .hire::before { content: ""; position: absolute; left: 1.2mm; right: 0; top: 8.3mm; border-top: .5pt solid ${C.hair}; }
  .hire li { position: relative; padding-right: 2.4mm; }
  .hire .n { display: block; height: 6mm; font-size: 17pt; line-height: 1; }
  .hire .dot { display: block; position: relative; width: 2mm; height: 2mm; margin: 1.3mm 0 0 .1mm;
    border: .6pt solid ${C.deep}; background: #fff; transform: rotate(45deg); }
  .hire b { display: block; margin-top: 2.4mm; color: ${C.deep}; font-size: 7.8pt; line-height: 1.25; font-weight: 700; }
  .hire em { display: block; margin-top: .7mm; font-style: normal; color: ${C.blue}; font-size: 7.2pt; line-height: 1.3; font-weight: 600; }
  .hire span:not(.n) { display: block; margin-top: .6mm; color: ${C.muted}; font-size: 6.9pt; line-height: 1.36; text-wrap: pretty; }
  .hire .gate .n { color: ${C.deep}; -webkit-text-stroke: 0; font-weight: 700; }
  .hire .gate .dot { background: ${C.deep}; outline: .4pt solid ${C.light}; outline-offset: .6mm; }
  .decides { display: grid; grid-template-columns: 1fr 1fr; column-gap: 9mm; margin-top: 2.4mm; padding-top: 2.2mm;
    border-top: .4pt solid ${C.hair}; }
  .decides p { margin: 0; padding-left: 3.5mm; border-left: 1.2pt solid ${C.blue}; font-size: 8.6pt; line-height: 1.45; }
  .decides b { color: ${C.deep}; }

  .kpi-wrap { margin-top: 4mm; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 3mm; border-top: .7pt solid ${C.deep}; }
  .kpis div { display: flex; flex-direction: column; padding: 2.6mm 4mm 0; border-left: .4pt solid ${C.hair}; }
  .kpis div:first-child { padding-left: 0; border-left: 0; }
  .kpis div:last-child { padding-right: 0; }
  .kpis b { color: ${C.deep}; font-size: 9.4pt; font-weight: 700; }
  .kpis p { margin: 1.2mm 0 0; font-size: 8.3pt; line-height: 1.45; flex: 1; }
  .kpis span { display: block; margin-top: 1.6mm; padding-top: 1.4mm; border-top: .4pt solid ${C.hair};
    color: ${C.blue}; font-size: 7.6pt; line-height: 1.4; font-weight: 600; }

  /* the organogram: the CEO on top, a stem to one bar, and a column per line hanging from it */
  .org { margin-top: 3.5mm; }
  .node { display: grid; grid-template-columns: 11mm auto; column-gap: 3.2mm; align-items: center; margin: 0; }
  .node .ph { position: relative; width: 11mm; aspect-ratio: 3 / 4; background: #fff; outline: .4pt solid ${C.light}; outline-offset: .7mm; }
  .node .ph img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .node b { display: block; color: ${C.deep}; font-size: 9pt; line-height: 1.2; font-weight: 700; letter-spacing: .1pt; }
  .node span { display: block; margin-top: .5mm; color: ${C.muted}; font-size: 7pt; line-height: 1.3; }

  /* the CEO plate: a double keyline round the photo and name, the photo over an engraved block */
  .org-top { display: flex; flex-direction: column; align-items: center; }
  .org-top::after { content: ""; display: block; height: 4.2mm; border-left: .7pt solid ${C.deep}; }
  .plate { position: relative; padding: 1.9mm 6mm 1.9mm 1.9mm; border: .5pt solid ${C.deep}; outline: .25pt solid ${C.light};
    outline-offset: -1.1mm; background: #fff; }
  .plate .node { grid-template-columns: 10mm auto; column-gap: 4.2mm; }
  .plate .ph { width: 10mm; outline: 0; border: .3pt solid ${C.light}; }
  .plate .eb { display: block; margin-bottom: 1.1mm; color: ${C.blue}; font-size: 5.4pt; letter-spacing: 1.2pt; }
  .plate b { font-size: 10pt; letter-spacing: .3pt; }
  .plate span { font-size: 7.2pt; }
  .plate i.c { position: absolute; width: 2.2mm; height: 2.2mm; border: 0 solid ${C.deep}; }
  .plate i.tl { left: -1.6mm; top: -1.6mm; border-left-width: .8pt; border-top-width: .8pt; }
  .plate i.tr { right: -1.6mm; top: -1.6mm; border-right-width: .8pt; border-top-width: .8pt; }
  .plate i.bl { left: -1.6mm; bottom: -1.6mm; border-left-width: .8pt; border-bottom-width: .8pt; }
  .plate i.br { right: -1.6mm; bottom: -1.6mm; border-right-width: .8pt; border-bottom-width: .8pt; }

  .org-lines { position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: .7pt solid ${C.deep}; }
  .org-lines::before { content: ""; position: absolute; left: 50%; top: -1.1mm; width: 1.6mm; height: 1.6mm; margin-left: -.8mm;
    border: .6pt solid ${C.deep}; background: #fff; transform: rotate(45deg); }
  .org-lines::after { content: ""; position: absolute; left: 0; right: 0; top: .9mm; border-top: .25pt solid ${C.light}; }
  /* each line hangs from the bar by a drop into its manager's photo */
  .lnode .ph::before { content: ""; position: absolute; left: 50%; top: -3.6mm; height: 2.9mm; border-left: .5pt solid ${C.deep}; }
  .org-line { min-width: 0; padding: 3.2mm 4mm 0; border-left: .4pt solid ${C.hair}; }
  .org-line:first-child { padding-left: 0; border-left: 0; }
  .org-line:last-child { padding-right: 0; }
  .lnode { align-items: start; }
  .lnode strong { display: block; margin-bottom: 1mm; color: ${C.deep}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 12.5pt; line-height: 1; font-weight: 700; letter-spacing: -.2pt; white-space: nowrap; }
  .lnode b { font-size: 8.6pt; }
  .lnode span { font-size: 6.8pt; }
  .lnode em { display: block; margin-top: .9mm; font-style: normal; color: ${C.blue}; font-size: 5.4pt; letter-spacing: .8pt; white-space: nowrap; }

  .tree { position: relative; list-style: none; margin: 0 0 0 5.5mm; padding: 0 0 0 4.2mm; }
  .tree li { position: relative; padding: 1mm 0 .9mm; }
  .tree li::before { content: ""; position: absolute; left: -4.2mm; top: 0; bottom: 0; border-left: .5pt solid ${C.hair}; }
  .tree li:last-child::before { bottom: auto; height: 2.1mm; }
  .tree li::after { content: ""; position: absolute; left: -4.2mm; top: 2.1mm; width: 2.4mm; border-top: .5pt solid ${C.hair}; }
  .tree .mk { position: absolute; left: -2.55mm; top: 1.35mm; width: 1.5mm; height: 1.5mm;
    border: .6pt solid ${C.deep}; background: #fff; transform: rotate(45deg); }
  .tree .reg { display: block; color: ${C.blue}; font-size: 5.4pt; line-height: 2.2mm; font-weight: 700; letter-spacing: .9pt; text-transform: uppercase; }
  .tree b { display: block; margin-top: .3mm; color: ${C.deep}; font-size: 7.9pt; line-height: 1.2; font-weight: 700; }
  .tree .t { display: block; margin-top: .1mm; color: ${C.muted}; font-size: 6.3pt; line-height: 1.25; }
  .tree .areas { display: block; margin-top: .6mm; color: ${C.body}; font-size: 6.1pt; line-height: 1.3; }
  .tree .areas span { white-space: nowrap; }
  .tree .open b { color: ${C.light}; font-weight: 600; }
  .tree .rsm > .mk { background: ${C.deep}; }
  .tree .sub { margin: .5mm 0 0 .6mm; padding-left: 3.4mm; }
  .tree .sub li::before { left: -3.4mm; }
  .tree .sub li::after { left: -3.4mm; width: 1.6mm; }

  /* page 3 — the two Part Two chapters */
  .route .soon .t { color: ${C.muted}; }
  .route .soon .dot { border-color: ${C.light}; }
  .route .soon .t em { display: block; margin-top: 1mm; font-style: normal; color: ${C.light}; font-size: 5.8pt;
    font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; }

  /* page 7 — the end of Part One: night navy and gold */
  .page.end { background: ${G.navy}; color: ${G.soft}; }
  .end .watermark { right: 4mm; bottom: 3mm; width: 70mm; opacity: .045; }
  .end .mast .mid .t { color: ${G.gold}; }
  .end .mast .mid .rule i { border-top-color: ${G.ghair}; }
  .end .mast .mid .rule b { border-color: ${G.gold}; }
  .end .mast .mid .s { color: ${G.muted}; }
  .end .mast .latin { width: 36mm; margin-left: -1.3mm; }

  .end-hero { position: relative; margin-top: 7mm; }
  .end-hero > .kicker { max-width: 128mm; }
  .end-hero .stamp { position: absolute; right: 0; top: 4.5mm; }
  .end .kicker { display: flex; align-items: center; gap: 3mm; color: ${G.gold}; }
  .end .kicker::after { content: ""; flex: 1; border-top: .5pt solid ${G.ghair}; }
  .end .kicker b { display: block; width: 1.4mm; height: 1.4mm; background: ${G.gold}; transform: rotate(45deg); }
  .end h1 { margin: 5mm 0 0; color: ${G.text}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 30pt; line-height: 1.06; font-weight: 250; letter-spacing: -0.7pt; }
  .end h1 b { display: block; margin-top: 2mm; font-size: 60pt; line-height: .92; font-weight: 700; letter-spacing: -2.2pt;
    color: ${G.gold}; white-space: nowrap; }
  .end .tick { margin: 5mm 0 4mm; }
  .end .tick i { border-top-color: ${G.gold}; }
  .end .tick i + i { border-top-color: ${G.deep}; }
  .end .tick i + i + i { border-top-color: ${G.ghair}; }
  .end .lead { max-width: 152mm; color: ${G.soft}; font-size: 10.8pt; line-height: 1.58; }
  .end .lead b { color: ${G.text}; font-weight: 600; }

  /* the whole handbook as one route: Part One done, Part Two to come */
  .whole { margin-top: 7mm; }
  .halves { display: grid; grid-template-columns: repeat(8, 1fr); }
  .halves span { display: flex; align-items: center; gap: 2.5mm; color: ${G.gold}; }
  .halves span::after { content: ""; flex: 1; margin-right: 3mm; border-top: .5pt solid ${G.ghair}; }
  .halves span:first-child { grid-column: 1 / 7; }
  .halves span:last-child { grid-column: 7 / 9; }
  .halves span:last-child::after { margin-right: 0; }
  .halves em { font-style: normal; color: ${G.muted}; }
  .end .route { margin-top: 3mm; }
  .end .route::before { border-top-color: ${G.ghair}; }
  .end .route .n { -webkit-text-stroke-color: ${G.gold}; }
  .end .route .dot { border-color: ${G.gold}; background: ${G.navy}; }
  .end .route .done .dot { background: ${G.gold}; }
  .end .route .t { color: ${G.text}; font-weight: 500; }
  .end .route .soon .n { color: ${G.gold}; -webkit-text-stroke: 0; font-weight: 700; }
  .end .route .soon .dot { outline: .4pt solid ${G.deep}; outline-offset: .7mm; }
  .end .route .soon .t { color: ${G.gold}; font-weight: 700; }

  .p2 { position: relative; margin-top: 7.5mm; padding: 6.5mm 8.5mm 6.5mm; overflow: hidden;
    background: ${G.panel}; border: .7pt solid ${G.gold}; }
  .p2::before { content: ""; position: absolute; inset: 1.3mm; border: .3pt solid ${G.deep}; pointer-events: none; }
  .p2 .ck { position: absolute; width: 4mm; height: 4mm; border: 0 solid ${G.gold}; }
  .p2 .ck.tl { left: -2.4mm; top: -2.4mm; border-left-width: .9pt; border-top-width: .9pt; }
  .p2 .ck.tr { right: -2.4mm; top: -2.4mm; border-right-width: .9pt; border-top-width: .9pt; }
  .p2 .ck.bl { left: -2.4mm; bottom: -2.4mm; border-left-width: .9pt; border-bottom-width: .9pt; }
  .p2 .ck.br { right: -2.4mm; bottom: -2.4mm; border-right-width: .9pt; border-bottom-width: .9pt; }
  .p2 .top { position: relative; display: grid; grid-template-columns: 52mm 1fr; column-gap: 9.5mm; align-items: center; }
  .p2 .kicker::after { display: none; }
  .seal { position: relative; width: 52mm; height: 52mm; }
  .seal svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .seal img { position: absolute; left: 50%; top: 50%; width: 15.5mm; height: 15.5mm; transform: translate(-50%, -50%); }
  .p2 .kicker { color: ${G.gold}; }
  .p2 h2 { margin: 3.5mm 0 0; color: ${G.text}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 23pt; line-height: 1.08; font-weight: 250; letter-spacing: -0.5pt; }
  .p2 h2 b { display: block; margin-top: .8mm; font-size: 31pt; line-height: 1; font-weight: 700; letter-spacing: -1.1pt; color: ${G.gold}; }
  .p2 .top p { margin: 3.8mm 0 0; color: ${G.soft}; font-size: 9.6pt; line-height: 1.56; }
  .p2 .tiles { position: relative; display: grid; grid-template-columns: 1fr 1fr; column-gap: 9mm; margin-top: 6.5mm;
    padding-top: 4.2mm; border-top: .4pt solid ${G.ghair}; }
  .tile .hd { display: flex; align-items: baseline; gap: 3mm; }
  .tile .n { font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 22pt; line-height: 1; font-weight: 200;
    color: transparent; -webkit-text-stroke: .55pt ${G.gold}; letter-spacing: -0.5pt; font-variant-numeric: lining-nums; }
  .tile b { color: ${G.text}; font-size: 10.2pt; font-weight: 700; letter-spacing: .1pt; }
  .tile p { margin: 2mm 0 0; color: ${G.soft}; font-size: 8.7pt; line-height: 1.5; }
  .sealed { margin: 2.6mm 0 0; padding: 0; border-top: .4pt solid ${G.ghair}; }
  .sealed div { display: grid; grid-template-columns: 16mm 1fr; align-items: center; padding: 1.35mm 0; border-bottom: .4pt solid ${G.hair}; }
  .sealed dt { color: ${G.muted}; font-size: 5.8pt; font-weight: 700; letter-spacing: 1.2pt; text-transform: uppercase; }
  .sealed dd { margin: 0; display: flex; align-items: center; gap: .9mm; color: ${G.light}; font-size: 8pt; }
  .sealed dd s { display: block; width: 1.25mm; height: 1.25mm; background: ${G.deep}; }
  .sealed dd em { font-style: normal; color: ${G.gold}; font-weight: 600; }

  .signoff { display: grid; grid-template-columns: 1fr 58mm; align-items: end; margin-top: 15mm; }
  .signoff .see { margin: 0 0 1mm; color: ${G.text}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif;
    font-size: 19pt; font-weight: 300; letter-spacing: -0.3pt; }
  .signoff .see b { color: ${G.gold}; font-weight: 600; }
  .signoff .name { position: relative; }
  /* the signature floats in the space above the name, so it adds no height to the page */
  .signoff .sig { position: absolute; left: -1mm; bottom: calc(100% - 1.5mm); height: 14mm; color: ${G.light}; }
  .signoff .sig svg { height: 100%; width: auto; display: block; }
  .signoff .rule { display: block; width: 12mm; border-top: 1.2pt solid ${G.gold}; margin: 3.4mm 0 2.2mm; }
  .signoff .who { color: ${G.text}; font-weight: 700; font-size: 10.5pt; letter-spacing: .2pt; }
  .signoff .what { margin-top: .4mm; color: ${G.muted}; font-size: 8pt; }
  .stamp { width: 29mm; height: 29mm; border: .7pt solid ${G.gold}; display: grid; place-content: center;
    text-align: center; gap: 1.1mm; }
  .stamp::before { content: ""; position: absolute; inset: 1.3mm; border: .3pt solid ${G.deep}; }
  .stamp .a { color: ${G.gold}; font-size: 5.8pt; font-weight: 700; letter-spacing: 1.4pt; text-transform: uppercase; }
  .stamp .b { color: ${G.text}; font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 13pt; font-weight: 700;
    letter-spacing: .5pt; line-height: 1; }
  .stamp .c { color: ${G.muted}; font-size: 5.6pt; letter-spacing: 1pt; text-transform: uppercase; }

  .end .foot { border-top-color: ${G.ghair}; color: ${G.muted}; }
  .end .foot .ph span { color: ${G.gold}; }
  .end .foot .num span { color: ${G.gold}; font-weight: 700; }
  .end .foot .num i { display: block; width: 1.6mm; height: 1.6mm; background: ${G.gold}; transform: rotate(45deg); align-self: center; }
`;

const masthead = `
  <header class="mast">
    <img class="latin" src="${logo}" alt="Sato Pharma">
    <div class="mid">
      <div class="t">New Starter Handbook</div>
      <div class="rule"><i></i><b></b><i></i></div>
      <div class="s">Human Resources · Head Office · October 2026</div>
    </div>
    <img class="arabic" src="${arabic}" alt="ساتو فارما">
  </header>
  ${band()}`;

const foot = (num, section) => `
  <footer class="foot">
    <div class="ph"><img src="${phoenix}" alt=""><span>Phoenix Workforce</span></div>
    <div class="code">Sato Pharma · Talent Acquisition · SATO-DIS-2026-01 v1.0</div>
    <div class="num"><span>${section}</span><b>${String(num).padStart(2, "0")}</b></div>
  </footer>`;

const pageWelcome = `
<section class="page">
  <img class="watermark" src="${arabic}" alt="">
  ${frame()}
  ${masthead}
  <div class="hero">
    <div>
      <div class="chapter"><span class="num">01</span><span class="lbl micro eyebrow">Welcome aboard</span></div>
      <h1>Welcome to<br>Sato&nbsp;Pharma, <b>Yomna.</b></h1>
      <div class="tick"><i></i><i></i><i></i></div>
      <p class="lead">We put this handbook together so your first weeks feel clear and calm.
        It’s yours to keep, and you can come back to it whenever you need it.</p>
      <dl class="facts">
        <div><dt>Role</dt><dd>Talent Acquisition Specialist</dd></div>
        <div><dt>Team</dt><dd>Human Resources, Head Office</dd></div>
        <div><dt>Reports to</dt><dd>Omar Gawish, HR Manager</dd></div>
        <div><dt>First day</dt><dd>Sunday, 18 October 2026</dd></div>
      </dl>
    </div>
    <figure class="portrait">
      <div class="engrave"></div>
      <div class="photo">
        <img src="${portrait}" alt="Dr. Yomna Gamal">
        <i class="c tl"></i><i class="c br"></i>
      </div>
      <figcaption class="cap micro">
        <i class="bar"></i>
        <span><span class="name">Dr. Yomna Gamal</span><span class="role">Talent Acquisition Specialist</span></span>
      </figcaption>
    </figure>
  </div>

  <div class="note">
    <div class="head micro">A note from your manager</div>
    <span class="quote">&ldquo;</span>
    <div class="body">
      <p>Dear Yomna,</p>
      <p>We’re really glad to have you with us.</p>
      <p>You’re joining at a busy and exciting time. Sato Pharma is growing, and new seats keep
        opening, in the field and here at Head Office. Every one of them starts with your work:
        finding the right person, treating every candidate with respect, and making sure the
        people we hire feel welcome from their very first call.</p>
      <p>This handbook is your roadmap. It explains who we are, what your role covers, who you’ll
        work with every day, and how to use your account on Phoenix, our HR system, so it saves
        you time instead of adding to it.</p>
      <p>Take it one section at a time during your first week, and keep it close after that. If
        anything isn’t clear, just ask. Nobody here expects you to know everything on day one.</p>
      <p>Welcome to the team. We’re looking forward to working with you.</p>
      <div class="sign">
        <p class="close">Warm regards,</p>
        <i class="rule"></i>
        <div class="who">Omar Gawish</div>
        <div class="what">HR Manager, Sato Pharma</div>
      </div>
    </div>
  </div>
  ${foot(1, "Welcome")}
</section>`;

const packs = [
  ["conviban", "Conviban"], ["rispadex", "Rispadex"], ["tebofortin", "Tebofortin"], ["dolabactin", "Dolabactin"],
  ["royafloxacin-500mg", "Royafloxacin"], ["guamusin", "Guamusin"], ["ivyronc", "Ivyronc"],
  ["royanoxicam-8mg", "Royanoxicam"], ["lacto-misr", "Lacto Misr"], ["osteosat", "Osteosat"], ["satoslim", "Satoslim"],
];

const pageAbout = `
<section class="page">
  <img class="watermark" src="${arabic}" alt="">
  ${frame()}
  ${masthead}
  <div class="hero" style="display:block; margin-top:6mm">
    <div class="chapter"><span class="num">02</span><span class="lbl micro eyebrow">About Sato Pharma</span></div>
  </div>
  <div class="about-hero">
    <h1>Built in Egypt, <b>for Egypt.</b></h1>
    <p class="lead">Sato Pharma started in 2014 as the idea of our owner and CEO, Dr.&nbsp;Anwar&nbsp;Gaweesh:
      a national, fully Egyptian pharmaceutical company with medicines people can trust and afford. Twelve
      years on, doctors prescribe our products, pharmacists recommend them, and patients across Egypt rely
      on them every day.</p>
  </div>
  <div class="stats">
    <div><b>2014</b><span>Founded in Egypt</span></div>
    <div><b>14</b><span>Products in our catalogue</span></div>
    <div><b>8</b><span>Therapeutic categories</span></div>
    <div><b>153</b><span>Positions in our structure</span><em>112 filled · 41 open</em></div>
  </div>

  <div class="name">
    <div class="shead micro">What our name stands for</div>
    <div class="letters">
      <div><span class="L">S</span><span class="w">Success</span></div>
      <div class="on"><span class="L">A</span><span class="w">Acquired</span></div>
      <div class="on"><span class="L">T</span><span class="w">Talented</span></div>
      <div><span class="L">O</span><span class="w">Operators</span></div>
    </div>
    <div class="motto">
      <p class="say"><b>Success</b> is <b>Acquired</b> by <b>Talented</b> <b>Operators</b>.</p>
      <p class="yours">Two of those four words are your job title. Every success here starts with the right
        person, and finding that person is now your work.</p>
    </div>
  </div>

  <div class="mv">
    <div class="col">
      <div class="k micro"><i>01</i>Our mission</div>
      <p>To make medicines that doctors prescribe with confidence, pharmacists recommend with pride and
        patients can afford, without ever cutting corners on quality, and to lead in every therapeutic
        area we enter.</p>
    </div>
    <div class="col">
      <div class="k micro"><i>02</i>Our vision</div>
      <p>To be the Egyptian pharmaceutical company people trust first: the name a doctor reaches for,
        the pack a pharmacist hands over, and the medicine a family keeps at home.</p>
    </div>
  </div>

  <div class="name" style="margin-top:4.8mm">
    <div class="shead micro">The values we work by</div>
    <div class="values">
      <div><b><i>01</i>Customer First</b><span>Patients, doctors and pharmacists come first. If a decision doesn’t help them, we rethink it.</span></div>
      <div><b><i>02</i>Passion for Success</b><span>We set ambitious targets and go after them together, month after month.</span></div>
      <div><b><i>03</i>Fairness</b><span>Same rules for everyone. We judge people on their work, and every candidate gets an equal chance.</span></div>
      <div><b><i>04</i>Respect</b><span>We listen, we speak plainly, and we treat everyone with dignity, whatever their title.</span></div>
    </div>
  </div>

  <div class="shelf">
    <div class="shead micro">Some of what we make</div>
    <div class="packs">
      ${packs.map(([f, label]) => `<img src="${asset(`products/${f}.png`)}" alt="${label}">`).join("")}
    </div>

  </div>
  ${foot(2, "About Sato Pharma")}
</section>`;

const chapters = [
  "Welcome", "About Sato Pharma", "Purpose of this handbook", "Meet the Head Office team",
  "Our organogram", "Your job description", "Sato Pharma policies", "Your Phoenix account",
];
const PART_TWO = 6; // chapters from this index on arrive in Part Two

const pagePurpose = `
<section class="page">
  <img class="watermark" src="${arabic}" alt="">
  ${frame()}
  ${masthead}
  <div class="hero" style="display:block; margin-top:6mm">
    <div class="chapter"><span class="num">03</span><span class="lbl micro eyebrow">Purpose of this handbook</span></div>
  </div>
  <div class="about-hero purpose-hero">
    <h1>Your first weeks, <b>made clear.</b></h1>
    <p class="lead">Starting a new job means new names, new systems and a lot of small questions. This
      handbook brings the essentials together in one place, so you can spend your first weeks learning
      the work instead of hunting for answers.</p>
  </div>

  <div class="route-wrap">
    <div class="shead micro">What’s inside</div>
    <div class="route">
      ${chapters.map((t, i) => `<div${i === 2 ? ' class="here"' : i >= PART_TWO ? ' class="soon"' : ""}><span class="n outline-n">${String(i + 1).padStart(2, "0")}</span><i class="dot"></i><span class="t">${t}${i === 2 ? "<em>You are here</em>" : i >= PART_TWO ? "<em>Part two</em>" : ""}</span></div>`).join("")}
    </div>
  </div>

  <div class="aims-wrap">
    <div class="shead micro">What it will help you do</div>
    <div class="aims">
      <div><span class="n outline-n">01</span><p style="margin:0"><b>Know the company</b><span>Who we are, what we make, and how
        the business is organised, from Head Office out to the field.</span></p></div>
      <div><span class="n outline-n">02</span><p style="margin:0"><b>Understand your role</b><span>What Talent Acquisition owns at
        Sato Pharma, what we expect from you, and who you work with.</span></p></div>
      <div><span class="n outline-n">03</span><p style="margin:0"><b>Put names to faces</b><span>The Head Office team you’ll see every
        day, and the managers you’ll be hiring for.</span></p></div>
      <div><span class="n outline-n">04</span><p style="margin:0"><b>Use Phoenix with confidence</b><span>How your Phoenix account
        works for your daily HR tasks, so it saves you time from week one.</span></p></div>
    </div>
  </div>

  <div class="steps-wrap">
    <div class="shead micro">How to get the most from it</div>
    <div class="steps">
      <div><span class="n outline-n">1</span><b>Read it in order</b><span>Go through it during your first week, one
        section at a time. Each part builds on the one before it.</span></div>
      <div><span class="n outline-n">2</span><b>Keep it close</b><span>Once you start hiring, come back to it. You’ll open
        the job description and the people pages most.</span></div>
      <div><span class="n outline-n">3</span><b>Ask early</b><span>If something isn’t clear, ask. A question on day two
        is much easier than a mistake in month two.</span></div>
    </div>
  </div>

  <div class="closing">
    <div>
      <div class="h micro">A guide, not a rulebook</div>
      <p>This handbook explains how things work here and who to go to. It doesn’t replace company policies or
        your employment contract. If the two ever say different things, the policy is the one that counts.</p>
    </div>
    <div>
      <div class="h micro">Kept up to date</div>
      <p>People join, seats open and our systems keep improving. When something here changes, we’ll update
        the handbook and give you the new copy. This is version 1.0, October 2026.</p>
    </div>
  </div>
  ${foot(3, "Purpose of this handbook")}
</section>`;

const duties = [
  ["Recruit for the field", "Screen new CVs daily and fill approved vacancies."],
  ["Headhunt for hard roles", "Approach strong people directly, not only applicants."],
  ["Build talent pools", "Keep ready lists by territory, line and role."],
  ["Shortlist with care", "Clear shortlists in Phoenix, with any risk flagged."],
  ["Own the candidate journey", "Every applicant gets a quick, honest answer."],
  ["Run onboarding", "Get each new joiner ready for day one and beyond."],
  ["Help good people stay", "Keep our good people from looking for jobs elsewhere."],
  ["Keep every record accurate", "Update each candidate in Phoenix the day it changes."],
];

const hiring = [
  ["Screen", "You", "CVs, the careers form and headhunting"],
  ["Shortlist", "You", "To the hiring manager in Phoenix"],
  ["Field interview", "District Manager", "First interview, in the candidate’s region"],
  ["Field interview", "Regional Manager", "Where the line has one, also in the field"],
  ["HR interview", "HR", "Once the field says yes"],
  ["Final interview", "National Sales Manager", "The last interview before an offer"],
  ["Offer", "HR department", "Approves and sets the salary, then you send the offer"],
  ["Onboarding", "You", "Paperwork with Yasmeena Elsafory"],
];

const kpis = [
  ["Hiring quality", "Managers get relevant candidates, and new hires pass their probation.", "Interview‑to‑offer ratio · probation retention"],
  ["Offer conversion", "The candidates we choose accept the offer and actually join.", "Offer acceptance % · offer‑to‑join %"],
  ["Retention support", "Our good people stay with us, and what might push them away is caught early.", "Early attrition · documented risk cases"],
  ["Employee connection", "The field force and management feel like one team with one goal, and no gap between them.", "Case closure time · recurring themes"],
];

const pageJob = `
<section class="page">
  <img class="watermark" src="${arabic}" alt="">
  ${frame()}
  ${masthead}
  <div class="hero" style="display:block; margin-top:6mm">
    <div class="chapter"><span class="num">06</span><span class="lbl micro eyebrow">Your job description</span></div>
  </div>
  <div class="about-hero purpose-hero">
    <h1>What you’re <b>here to do.</b></h1>
    <p class="lead">You find, screen and bring in the people Sato Pharma needs, mostly medical reps and district
      managers for the field, and you help our good people stay. For most candidates, you’re the first face of the company.</p>
  </div>

  <dl class="rolefacts">
    <div><dt>Job title</dt><dd>Talent Acquisition Specialist<small>Human Resources</small></dd></div>
    <div><dt>Reports to</dt><dd>Omar Gawish<small>HR Manager</small></dd></div>
    <div><dt>Where</dt><dd>Head Office<small>Sheraton, Cairo</small></dd></div>
    <div><dt>Working week</dt><dd>Sunday to Thursday<small>9 AM to 5 PM · Full-time</small></dd></div>
  </dl>

  <div class="duties-wrap">
    <div class="shead micro">Your main responsibilities</div>
    <div class="duties">
      ${duties.map(([t, d], i) => `<div><span class="n outline-n">${String(i + 1).padStart(2, "0")}</span><p style="margin:0"><b>${t}</b><span>${d}</span></p></div>`).join("")}
    </div>
  </div>

  <div class="hire-wrap">
    <div class="shead micro">How hiring works<span class="k">Medical representatives</span></div>
    <ol class="hire">
      ${hiring.map(([t, who, d], i) => `<li${i === 6 ? ' class="gate"' : ""}><span class="n outline-n">${i + 1}</span><i class="dot"></i><b>${t}</b><em>${who}</em><span>${d}</span></li>`).join("")}
    </ol>
    <div class="decides">
      <p><b>Each interviewer decides</b> who moves on to the next step.</p>
      <p><b>HR approves the candidate</b> and decides the salary.</p>
    </div>
  </div>

  <div class="kpi-wrap">
    <div class="shead micro">How your work is measured<span class="k">Your KPIs</span></div>
    <div class="kpis">
      ${kpis.map(([a, g, m]) => `<div><b>${a}</b><p>${g}</p><span>${m}</span></div>`).join("")}
    </div>
  </div>
  ${foot(6, "Your job description")}
</section>`;

// The Head Office team. Photos are cropped to one 3:4 frame by crop-team.mjs; a person with
// no photo yet gets an outlined initials tile.
const teamPhoto = (f) => (f ? asset(`team/crop/${f}.jpg`, "image/jpeg") : null);
// Three rows of six columns. Each row holds department groups, and a group's heading rule runs
// the width of its own people: [group, [[photo, name, title, note?], ...]].
const teamRows = [
  [
    ["The leadership team", [
      ["anwar", "Dr Anwar Gaweesh", "Chief Executive Officer"],
      ["maraghy", "Ahmed El Maraghy", "Finance and Admin Manager"],
      ["omar", "Omar Gawish", "HR Manager"],
      ["hossam", "Hossam AboElftouh", "Marketing Manager"],
      ["sahar", "Sahar Khalil", "R&amp;D Manager"],
      ["khaled", "Khaled Bedair", "SFE Manager"],
    ]],
  ],
  [
    ["Sales", [
      ["magdy", "Magdy El Senosey", "National Sales Manager"],
      ["ali", "Ali Mohamed", "National Sales Manager"],
      ["amr", "Amr Naguib", "National Sales Manager"],
    ]],
    ["Marketing", [
      ["rasha", "Rasha Sabry", "Group Product Manager"],
      ["sharaf", "Ahmed SharafEldeen", "Product Manager"],
    ]],
    ["Finance", [["adel", "Adel El Sayed", "Financial Advisor"]]],
  ],
  [
    ["Human Resources", [["yasmeena", "Yasmeena Elsafory", "HR Generalist"]]],
    ["R&amp;D and Regulatory", [
      [null, "Reham Mahmoud", "Regulatory Affairs Supervisor"],
      ["samaa", "Samaa Mosaad", "QPPV"],
    ]],
    ["Administration", [
      ["ahmedamin", "Ahmed Amin", "Admin Assistant"],
      ["mahmoud", "Mahmoud Ibrahim", "Admin Assistant"],
      ["zain", "Mohamed Zain", "Buffet"],
    ]],
  ],
];
const initialsOf = (name) => name.split(/\s+/).filter((w) => /^[A-Z]/.test(w) && w !== "Dr").slice(0, 2).map((w) => w[0]).join("");
const person = ([f, name, title, note]) => {
  const src = teamPhoto(f);
  const ph = src
    ? `<div class="ph"><img src="${src}" alt="${name}"></div>`
    : `<div class="ph none"><span class="outline-n">${initialsOf(name)}</span></div>`;
  return `<figure class="person">${ph}<figcaption><b>${name}</b><span>${title}</span>${note ? `<em>${note}</em>` : ""}</figcaption></figure>`;
};
const teamRow = (groups, i) => `
  <div class="team-row${i === 0 ? " lead-row" : ""}">${groups.map(([title, people]) => `
    <div class="grp" style="--n:${people.length}">
      <div class="ghead micro">${title}</div>
      <div class="gpeople">${people.map(person).join("")}</div>
    </div>`).join("")}
  </div>`;

const pageTeam = `
<section class="page">
  <img class="watermark" src="${arabic}" alt="">
  ${frame()}
  ${masthead}
  <div class="hero" style="display:block; margin-top:6mm">
    <div class="chapter"><span class="num">04</span><span class="lbl micro eyebrow">Meet the Head Office team</span></div>
  </div>
  <div class="about-hero purpose-hero">
    <h1>Head Office, <b>who’s who.</b></h1>
    <p class="lead">Your colleagues at Head Office in Sheraton, from the leadership team to the people who keep the
      office running. Learn the names and faces early, and don’t wait to be introduced: a quick hello goes a long way.</p>
  </div>
  ${teamRows.map(teamRow).join("")}
  ${foot(4, "Meet the Head Office team")}
</section>`;

// The organogram, read from Phoenix's seat model (the au_v_org_tree view) on 12 October 2026: each
// line's National Sales Manager, then its districts as [region, district manager, title, areas].
// A district whose manager seat is empty has a null name. Pedia's Regional Sales Manager carries
// three of its districts.
const DSM = "District Sales Manager";
const orgLines = [
  ["Pedia", ["ali", "Ali Mohamed"], [
    ["Cairo", null, DSM, ["Cairo East 1", "Cairo East 2", "Cairo West", "Heliopolis", "Nasr City"]],
    ["Giza", "Taha Mohamed", "Senior District Manager", ["Dokki – Mohandseen – Bolak", "Giza – Giza Centers", "Haram – Faisal", "Helwan – Maadi", "Imbaba – Imbaba Centers", "October – Zayed"]],
    ["Upper Egypt 1", "Osama Mohamed", DSM, ["Assuit 1", "Assuit 2", "Beni Suef", "Fayoum", "Minia 1", "Minia 2"]],
    ["Upper Egypt 2", "Mohamed Ramadan", DSM, ["Qena 1", "Qena 2", "Sohag 1", "Sohag 2"]],
  ], ["Hany Saad", "Regional Sales Manager", [
    ["Alex-BHR", "Mohamed Eleiwa", DSM, ["Alex Center", "Alex East", "Alex West", "Behira 1", "Behira 2"]],
    ["Delta (1)", "Nermeen Salah", DSM, ["Gharbia 1 (Tanta)", "Gharbia 2 (Mahalla)", "Kafr El-Sheikh 1", "Menoufia 1", "Menoufia 2", "Qalubeya"]],
    ["Delta (2)", "Sahar El Gallad", DSM, ["Dakahlia 1", "Dakahlia 2", "Dakahlia 3", "Port Said – Domiat", "Sharkia 1", "Sharkia 2"]],
  ]]],
  ["CNS", ["amr", "Amr Naguib"], [
    ["Cairo", "Mina Farouk", DSM, ["Cairo East 1", "Cairo East 2", "Cairo West", "Heliopolis", "Nasr City"]],
    ["Giza", "Sameh El Hoseiny", DSM, ["Dokki – Mohandseen – Bolak", "Down town", "Giza – Giza Centers", "Haram – Faisal", "Helwan – Maadi", "October – Zayed"]],
    ["Alex-BHR", "Saad Salama", DSM, ["Alex Center", "Alex East", "Alex West", "Behira 1", "Behira 2", "Kafr El-Sheikh 1"]],
    ["Delta (1)", "Mahmoud ElHassanin", DSM, ["Gharbia 1 (Tanta)", "Gharbia 2 (Mahalla)", "Menoufia 1", "Menoufia 2", "Qalubeya"]],
    ["Delta (2)", "Sally Saied", DSM, ["Dakahlia 1", "Dakahlia 2", "Dakahlia 3", "Port Said – Domiat", "Sharkia 1", "Sharkia 2"]],
    ["Upper Egypt", "Amgad Ibrahim", DSM, ["Assuit 1", "Assuit 2", "Minia 1", "Minia 2", "Qena 1", "Sohag 1", "Sohag 2"]],
  ]],
  ["Anti Infective", ["magdy", "Magdy El Senosey"], [
    ["Cairo", "Momen Abdelhady", DSM, ["Cairo East 1", "Cairo East 2", "Cairo West", "Heliopolis", "Nasr City"]],
    ["Giza", "Mahmoud Eldaly", DSM, ["Dokki – Mohandseen – Bolak", "Fayoum", "Giza – Giza Centers", "Haram – Faisal", "Helwan – Maadi", "Imbaba – Imbaba Centers"]],
    ["Alex-BHR", "Sara Yohana", DSM, ["Alex Center", "Alex East", "Alex West", "Behira 1", "Behira 2"]],
    ["Delta (1)", "Dina Hamdy", DSM, ["Gharbia 1 (Tanta)", "Gharbia 2 (Mahalla)", "Kafr El-Sheikh 1", "Menoufia 1", "Menoufia 2"]],
    ["Delta (2)", "Salim Gomaa", DSM, ["Dakahlia 1", "Dakahlia 2", "Dakahlia 3", "Port Said – Domiat"]],
    ["Delta (3)", "Samaa AbdelRahman", DSM, ["Qalubeya", "Sharkia 1", "Sharkia 2", "Suez"]],
    ["Upper Egypt 1", "Nosiba Salah", DSM, ["Beni Suef", "Minia 1", "Minia 2"]],
    ["Upper Egypt 2", "Weaam Gweed", DSM, ["Assuit 1", "Assuit 2", "Qena 1", "Qena 2", "Sohag 1", "Sohag 2"]],
  ]],
];
const ph = (f, name) => `<div class="ph"><img src="${teamPhoto(f)}" alt="${name}"></div>`;
const ceoPlate = (f, name, title) => `
      <div class="plate"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
        <figure class="node">${ph(f, name)}<figcaption><span class="eb micro">Sato Pharma</span><b>${name}</b><span>${title}</span></figcaption></figure>
      </div>`;
const lineNode = (f, line, name, count) =>
  `<figure class="node lnode">${ph(f, name)}<figcaption><strong>${line}</strong><b>${name}</b><span>National Sales Manager</span><em class="micro">${count}</em></figcaption></figure>`;
// Each area is kept whole on its line; the separator rides at the end of the area before it.
const areaList = (areas) => areas.map((a, i) => `<span>${a}${i < areas.length - 1 ? " ·" : ""}</span>`).join(" ");
const district = ([reg, name, title, areas]) => `
        <li${name ? "" : ' class="open"'}><i class="mk"></i><span class="reg">${reg}</span><b>${name ?? "Open seat"}</b><span class="t">${title}</span><span class="areas">${areaList(areas)}</span></li>`;
const orgLine = ([line, [f, nsm], districts, rsm]) => {
  const all = [...districts, ...(rsm ? rsm[2] : [])];
  const areas = all.reduce((s, d) => s + d[3].length, 0);
  return `
    <div class="org-line">
      ${lineNode(f, line, nsm, `${all.length} districts · ${areas} areas`)}
      <ul class="tree">${districts.map(district).join("")}${rsm ? `
        <li class="rsm"><i class="mk"></i><span class="reg">${rsm[2].length} districts</span><b>${rsm[0]}</b><span class="t">${rsm[1]}</span>
          <ul class="tree sub">${rsm[2].map(district).join("")}
          </ul>
        </li>` : ""}
      </ul>
    </div>`;
};

const pageOrg = `
<section class="page">
  <img class="watermark" src="${arabic}" alt="">
  ${frame()}
  ${masthead}
  <div class="hero" style="display:block; margin-top:6mm">
    <div class="chapter"><span class="num">05</span><span class="lbl micro eyebrow">Our organogram</span></div>
  </div>
  <div class="about-hero purpose-hero">
    <h1>Three lines, <b>one team.</b></h1>
    <p class="lead">Our field force works in three lines: Pedia, CNS and Anti Infective. Each line has its own National
      Sales Manager and district managers, with one medical rep in each area. Phoenix’s Organogram always shows
      who sits where today.</p>
  </div>
  <div class="org">
    <div class="org-top">${ceoPlate("anwar", "Dr Anwar Gaweesh", "Chief Executive Officer")}</div>
    <div class="org-lines">${orgLines.map(orgLine).join("")}
    </div>
  </div>
  ${foot(5, "Our organogram")}
</section>`;

const mastheadEnd = `
  <header class="mast">
    <img class="latin" src="${logoReverse}" alt="Sato Pharma">
    <div class="mid">
      <div class="t">New Starter Handbook</div>
      <div class="rule"><i></i><b></b><i></i></div>
      <div class="s">Human Resources · Head Office · October 2026</div>
    </div>
    <img class="arabic" src="${arabicGold}" alt="ساتو فارما">
  </header>
  ${band(G.gold)}`;

const pageEnd = `
<section class="page end">
  ${frame(GOLD_FRAME)}
  ${mastheadEnd}
  <div class="end-hero">
    <div class="kicker micro"><b></b>Part One · Complete</div>
    <div class="stamp"><span class="a">Part One</span><span class="b">Complete</span><span class="c">October 2026</span></div>
    <h1>The end of Part One. <b>Not the end.</b></h1>
    <div class="tick"><i></i><i></i><i></i></div>
    <p class="lead">You now know who we are, who’s who at Head Office, how our three lines are organised and
      what you’re here to do. That’s the ground <b>everything else stands on.</b></p>
  </div>

  <div class="whole">
    <div class="halves micro"><span>Part One</span><span>Part Two</span></div>
    <div class="route">
      ${chapters.map((t, i) => `<div class="${i < PART_TWO ? "done" : "soon"}"><span class="n outline-n">${String(i + 1).padStart(2, "0")}</span><i class="dot"></i><span class="t">${t}</span></div>`).join("")}
    </div>
  </div>

  <div class="p2">
    <img class="watermark" src="${arabicGold}" alt="">
    <i class="ck tl"></i><i class="ck tr"></i><i class="ck bl"></i><i class="ck br"></i>
    <div class="top">
      <div class="seal">${diamondSeal()}<img src="${phoenix}" alt="Phoenix"></div>
      <div>
        <div class="kicker micro">Part Two · arrives within the week</div>
        <h2>Your Phoenix account <b>is almost ready.</b></h2>
        <p>One system runs your day here: candidates, shortlists, onboarding and every record you keep.
          Part Two hands you the keys, along with Sato Pharma’s policies.</p>
        <dl class="sealed">
          <div><dt>Sign-in</dt><dd>${"<s></s>".repeat(14)}</dd></div>
          <div><dt>Password</dt><dd>${"<s></s>".repeat(10)}</dd></div>
          <div><dt>Status</dt><dd><em>Being prepared for you</em></dd></div>
        </dl>
      </div>
    </div>
  </div>

  <div class="signoff">
    <p class="see">See you in <b>Part Two.</b></p>
    <div class="name">
      ${signature}
      <i class="rule"></i>
      <div class="who">Omar Gawish</div>
      <div class="what">HR Manager, Sato Pharma</div>
    </div>
  </div>
  <footer class="foot">
    <div class="ph"><img src="${phoenix}" alt=""><span>Phoenix Workforce</span></div>
    <div class="code">Sato Pharma · Talent Acquisition · SATO-DIS-2026-01 v1.0</div>
    <div class="num"><span>End of Part One</span><i></i></div>
  </footer>
</section>`;

const pages = [pageWelcome, pageAbout, pagePurpose, pageTeam, pageOrg, pageJob, pageEnd];
const doc = (body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sato Pharma — New Starter Handbook · Talent Acquisition</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;

writeFileSync(join(dir, "handbook.html"), doc(pages.join("\n")));
pages.forEach((p, i) => writeFileSync(join(dir, `page-${String(i + 1).padStart(2, "0")}.html`), doc(p)));
console.log(`wrote handbook.html and ${pages.length} single pages in ${dir}`);
