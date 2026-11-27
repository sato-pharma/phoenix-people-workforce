// Direct-order delivery receipt books (إذن تسليم وتسلم بضاعة) + the book custody acknowledgement.
// Usage: node build.mjs <outDir> [--sample]
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// generator/ -> direct-order-receipt-books/ -> skills/ -> .claude/ -> the repo. PHOENIX_REPO overrides (the _generator copy outside the repo).
const REPO = process.env.PHOENIX_REPO ?? path.resolve(HERE, "../../../..");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const require = createRequire(REPO + "/package.json");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { QRCodeSVG } = require("qrcode.react");
const puppeteer = require("puppeteer-core");
const ExcelJS = require("exceljs");

const OUT = process.argv[2];
const SAMPLE = process.argv.includes("--sample");
// --sample-codes=AAAAAA,BBBBBB keeps a rebuilt sample on the codes the guides and videos already show (throwaway codes only).
const SAMPLE_CODES = (process.argv.find((a) => a.startsWith("--sample-codes=")) ?? "").slice(15).split(",").filter(Boolean);
if (SAMPLE_CODES.some((c) => !/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(c))) { console.error("--sample-codes takes six-character codes from the receipt alphabet"); process.exit(1); }
if (!OUT || OUT.startsWith("--")) { console.error("Usage: node build.mjs <outDir> [--sample]"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const PER_BOOK = 50;
const SPARE_BOOKS = 2;
// Two originals and a copy (owner, 27 Nov 2026): the set is bound at the stub with Original 1 on top.
// Original 1 — the manager's custody of the goods: it stays in the book, its photo goes on Phoenix within 3 days.
// Original 2 — the customer's page, with no manager details: the customer signs and stamps it; the manager tears it
//   out, keeps it, puts its photo on Phoenix within 6 working days and sends it to Finance.
// The customer copy — the carbon of Original 2, torn out and left with the customer.
// Everything written in the shared block (date, customer, items, value) copies down to all three. The custody zone
// of plies 2 and 3 is DESENSITIZED by the printer, so the manager's name, ID and signature never reach the customer.
const PARTS = [
  { key: "O1", kind: "custody", ar: "الأصل الأول — إقرار العهدة", note: "يبقى في الدفتر · يُرفع على فينكس خلال 3 أيام", en: "ORIGINAL 1" },
  { key: "O2", kind: "customer", ar: "الأصل الثاني — استلام العميل", note: "يُنزع ويُرفع على فينكس خلال 6 أيام عمل ثم يُرسَل للمالية", en: "ORIGINAL 2" },
  { key: "C", kind: "customer", ar: "صورة العميل", note: "تُنزع وتُسلَّم للعميل", en: "CUSTOMER COPY" },
];
const C = { deep: "#0A527D", blue: "#0A6BA6", light: "#1482C2", tint: "#F2F6FA", hair: "#B9C7D4", muted: "#5A6B7C", body: "#1A1A1A", ghost: "#DCE6EF" };
const FONT = '"Tahoma", "Segoe UI", "Traditional Arabic", "Noto Sans Arabic", Arial, sans-serif';
const LOGO = fs.readFileSync(REPO + "/public/brand/sato-pharma-logo-on-light.svg", "utf8")
  .replace(/<\?xml[^>]*>/, "").replace(/<title>.*?<\/title>/, "")
  .replace(/width="401" height="158"/, 'width="100%" height="100%"');
const ALPHA = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pad = (n, w = 6) => String(n).padStart(w, "0");
const TITLE_AR = { "District Sales Manager": "مدير منطقة", "Senior District Manager": "مدير منطقة أول" };
const LINE_AR = { Pedia: "خط الأطفال (Pedia)", "Anti Infective": "خط المضادات الحيوية (Anti Infective)" };

// ── the register: serial ⇄ code ⇄ book ⇄ manager. Made ONCE, then reused, so a re-run never re-issues codes.
const regPath = path.join(OUT, "register.json");
// A sample never touches a register: it refuses a folder that holds one, and its codes are minted fresh and never saved.
if (SAMPLE && fs.existsSync(regPath)) { console.error("Refused: --sample into a folder with register.json would print REAL codes. Use a new empty folder."); process.exit(1); }
const managers = JSON.parse(fs.readFileSync(path.join(HERE, "managers.json"), "utf8"));
let register;
if (!SAMPLE && fs.existsSync(regPath)) {
  register = JSON.parse(fs.readFileSync(regPath, "utf8"));
} else {
  const holders = [...managers, ...Array.from({ length: SPARE_BOOKS }, () => null)];
  register = holders.map((m, i) => {
    const book = i + 1;
    const first = i * PER_BOOK + 1;
    return {
      book, holder: m,
      first, last: first + PER_BOOK - 1,
      receipts: Array.from({ length: PER_BOOK }, (_, k) => ({
        serial: first + k,
        code: (SAMPLE && SAMPLE_CODES[k]) || Array.from({ length: 6 }, () => ALPHA[randomInt(ALPHA.length)]).join(""),
      })),
    };
  });
  if (!SAMPLE) fs.writeFileSync(regPath, JSON.stringify(register, null, 1));
}

// ── the per-page seal: a guilloche rosette whose curve is set by the page's own code
function seed(code, serial) {
  let h = 2166136261 ^ serial;
  for (const ch of code) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
function rosettePaths(code, serial, r, n = 900) {
  const rnd = seed(code, serial);
  const curves = [];
  for (let c = 0; c < 3; c++) {
    const k = 7 + Math.floor(rnd() * 17);          // petals
    const m = 2 + Math.floor(rnd() * 2);           // secondary wave
    const a = 0.58 + rnd() * 0.12, b = 0.22 + rnd() * 0.1, d = 0.02 + rnd() * 0.03;
    const ph = rnd() * Math.PI * 2;
    let dstr = "";
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const rr = r * (a + b * Math.cos(k * t + ph) + d * Math.cos(m * k * t));
      const x = rr * Math.cos(t), y = rr * Math.sin(t);
      dstr += (i ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
    }
    curves.push(dstr + "Z");
  }
  return curves;
}
function sealSvg(code, serial, partEn) {
  const p = rosettePaths(code, serial, 40);
  const ring = `SATO PHARMA · ${pad(serial)} · ${code} · ${partEn} · `.repeat(3);
  return `<svg viewBox="-50 -50 100 100" class="seal" aria-label="seal">
    <defs><path id="ring${serial}${partEn.replace(/\W/g, "")}" d="M0,-46 A46,46 0 1,1 -0.01,-46"/></defs>
    <circle r="49" fill="none" stroke="${C.deep}" stroke-width="0.6"/>
    <circle r="43" fill="none" stroke="${C.deep}" stroke-width="0.35"/>
    <text font-family="Consolas, monospace" font-size="3.1" fill="${C.deep}" letter-spacing="0.15"><textPath href="#ring${serial}${partEn.replace(/\W/g, "")}">${esc(ring)}</textPath></text>
    <path d="${p[0]}" fill="none" stroke="${C.blue}" stroke-width="0.32"/>
    <path d="${p[1]}" fill="none" stroke="${C.light}" stroke-width="0.28"/>
    <path d="${p[2]}" fill="none" stroke="${C.deep}" stroke-width="0.22"/>
    <circle r="15" fill="#fff" stroke="${C.deep}" stroke-width="0.35"/>
    <text y="-3" text-anchor="middle" font-family="Consolas, monospace" font-size="6.2" font-weight="700" fill="${C.deep}">${pad(serial)}</text>
    <text y="6" text-anchor="middle" font-family="Consolas, monospace" font-size="5.2" fill="${C.deep}" letter-spacing="0.4">${code}</text>
  </svg>`;
}
function groundSvg(code, serial, partEn) {
  // the page watermark: the same rosette, large and pale, behind the item table
  const p = rosettePaths(code, serial, 40, 1600);
  return `<svg viewBox="-50 -50 100 100" class="wm">
    ${p.map((d, i) => `<path d="${d}" fill="none" stroke="${C.ghost}" stroke-width="${[0.16, 0.13, 0.11][i]}"/>`).join("")}
  </svg>`;
}
// The void pantograph, drawn as the printer will draw it: one 600 dpi image, reused on every page.
// Outside the hidden words: single 1-pixel dots on a 2-pixel grid (0.085 mm), too fine for a copier's scanner.
// Inside the words: 4x4-pixel dots (0.17 mm) on an 8-pixel grid (0.34 mm), coarse enough that a copier keeps them.
// Both cover exactly 1/4 of the area, so on the original the two read as the same pale tint.
const sharpLib = require("sharp");
const VP_W_MM = 188, VP_H_MM = 186, DPI = 600;
async function buildVoidPantograph() {
  const W = Math.round(VP_W_MM / 25.4 * DPI), H = Math.round(VP_H_MM / 25.4 * DPI);
  const pxmm = DPI / 25.4;
  const cx = (VP_W_MM / 2) * pxmm;
  const words = [28, 92, 156].map((y) => {
    const yy = y * pxmm;
    return '<text x="' + cx + '" y="' + yy + '" text-anchor="middle" font-family="Tahoma" font-weight="bold" font-size="' + 21 * pxmm + '" fill="#000" transform="rotate(-14 ' + cx + " " + yy + ')">مُصوَّر — غير صالح</text>';
  }).join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><rect width="100%" height="100%" fill="#fff"/>' + words + "</svg>";
  const mask = await sharpLib(Buffer.from(svg)).greyscale().raw().toBuffer();
  const ch = mask.length / (W * H);
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inWord = mask[(y * W + x) * ch] < 128;
    const on = inWord ? (x % 8 < 4 && y % 8 < 4) : (x % 2 === 0 && y % 2 === 0);
    if (on) { const o = (y * W + x) * 4; out[o] = 0x8f; out[o + 1] = 0xa9; out[o + 2] = 0xc2; out[o + 3] = 255; }
  }
  const png = await sharpLib(out, { raw: { width: W, height: H, channels: 4 } }).png({ palette: true, colours: 2, compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(path.join(OUT, "void-pantograph-600dpi.png"), png);
  return "data:image/png;base64," + png.toString("base64");
}
const VP_URI = await buildVoidPantograph();
console.error("void pantograph KB", Math.round((VP_URI.length * 0.75) / 1024));
function voidPantograph() { return '<img class="vp" src="' + VP_URI + '" alt="">'; }
function microLine(code, serial, partEn) {
  return `<div class="micro" dir="ltr">${esc(`SATOPHARMA${pad(serial)}${code}${partEn.replace(/\s/g, "")}`.repeat(24))}</div>`;
}
function qr(serial, code) {
  return renderToStaticMarkup(React.createElement(QRCodeSVG, { value: `SATO-DO|${pad(serial)}|${code}`, level: "M", marginSize: 0, fgColor: "#000000", bgColor: "#FFFFFF", size: 256 }))
    .replace("<svg ", '<svg class="qr" ');
}

const CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${FONT}; color: ${C.body}; font-size: 9.4pt; line-height: 1.5; }
.sheet { position: relative; background: #fff; width: 210mm; height: 297mm; padding: 9mm 11mm 8mm; overflow: hidden; page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.vp { position: absolute; left: 11mm; top: 92mm; width: 188mm; height: 186mm; z-index: 0; image-rendering: pixelated; }
.wm { position: absolute; width: 150mm; height: 150mm; left: 30mm; top: 95mm; z-index: 0; }
.sheet > *:not(.wm):not(.foot):not(.vp) { position: relative; z-index: 1; }
.sheet > .foot { z-index: 1; }
.mast { display: flex; direction: ltr; align-items: center; gap: 5mm; }
.mast__logo { width: 36mm; height: 14.2mm; flex: none; }
.mast__title { flex: 1; text-align: center; direction: rtl; }
.mast__title .co { margin: 0; font-size: 10pt; font-weight: 700; color: ${C.deep}; }
.mast__title .co span { font-family: Aptos, "Segoe UI", sans-serif; letter-spacing: 0.06em; }
.mast__title h1 { margin: 0.6mm 0 0; font-size: 17pt; font-weight: 700; color: ${C.deep}; line-height: 1.25; }
.mast__sec { flex: none; display: flex; direction: ltr; align-items: center; gap: 2.5mm; }
.seal { width: 25mm; height: 25mm; display: block; }
.qr { width: 15mm; height: 15mm; display: block; }
.band { height: 1.5mm; margin: 2.6mm 0 0; background: BAND center / 6mm 1.5mm repeat-x; }
.micro { margin-top: 0.6mm; font-family: Consolas, monospace; font-size: 2.6pt; line-height: 1; color: ${C.blue}; white-space: nowrap; overflow: hidden; letter-spacing: 0.02em; }
.part { display: flex; justify-content: space-between; align-items: baseline; margin-top: 2mm; padding-bottom: 1.2mm; border-bottom: 0.3mm solid ${C.hair}; font-size: 8.6pt; }
.part b { color: ${C.deep}; font-size: 10pt; }
.part .meta { color: ${C.muted}; }
.part .meta bdi { font-family: Consolas, monospace; color: ${C.deep}; }
.f { display: flex; flex-wrap: wrap; gap: 0 8mm; margin-top: 2.4mm; }
.f__row { display: flex; align-items: baseline; gap: 2mm; flex: 1 1 100%; min-height: 7.4mm; }
.f__row--half { flex: 1 1 calc(50% - 4mm); }
.f__l { flex: none; font-weight: 700; color: ${C.deep}; }
.f__v { flex: 1; border-bottom: 0.25mm dotted ${C.muted}; min-height: 5.4mm; padding: 0 1.5mm; font-weight: 700; }
.f__v--serial { font-family: Consolas, monospace; font-size: 13pt; letter-spacing: 0.08em; color: ${C.deep}; border-bottom: 0.3mm solid ${C.deep}; }
.f__v small { font-weight: 400; color: ${C.muted}; font-size: 8pt; }
.date { flex: 1; letter-spacing: 0.12em; color: ${C.muted}; border-bottom: 0.25mm dotted ${C.muted}; padding: 0 1.5mm; }
.sec { margin: 3.4mm 0 1.4mm; padding-bottom: 0.8mm; border-bottom: 0.8pt solid ${C.blue}; color: ${C.deep}; font-size: 10pt; font-weight: 700; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { color: ${C.deep}; font-size: 8.2pt; font-weight: 700; padding: 1.4mm 1mm; border-top: 0.5mm solid ${C.deep}; border-bottom: 0.3mm solid ${C.deep}; text-align: center; line-height: 1.25; }
td { height: 10.6mm; border-bottom: 0.25mm solid ${C.hair}; text-align: center; font-size: 9pt; }
td + td, th + th { border-inline-start: 0.25mm solid ${C.hair}; }
tbody tr:nth-child(even) td { background: rgba(10, 107, 166, 0.06); }
td.n { color: ${C.deep}; font-weight: 700; }
.total { display: flex; gap: 2mm; align-items: baseline; margin-top: 2.4mm; padding: 1.8mm 0 1.6mm; border-bottom: 0.5mm solid ${C.deep}; font-weight: 700; color: ${C.deep}; }
.total .gap { display: inline-block; min-width: 22mm; border-bottom: 0.25mm dotted ${C.muted}; }
.total .wide { flex: 1; border-bottom: 0.25mm dotted ${C.muted}; }
p { margin: 0; text-align: justify; }
.box { margin-top: 2.6mm; padding: 2mm 3mm 2.4mm; border: 0.3mm solid ${C.hair}; border-inline-start: 0.9mm solid ${C.deep}; }
.box h3 { margin: 0 0 1mm; font-size: 9.6pt; color: ${C.deep}; }
.box p { font-size: 8.9pt; line-height: 1.6; }
.blank { display: inline-block; min-width: 34mm; border-bottom: 0.25mm dotted ${C.muted}; }
.sig { display: flex; gap: 6mm; margin-top: 5mm; }
.sig > div { flex: 1; display: flex; gap: 1.5mm; align-items: baseline; }
.sig b { color: ${C.deep}; flex: none; }
.sig span { flex: 1; border-bottom: 0.25mm dotted ${C.muted}; min-height: 6mm; }
.client { display: flex; gap: 4mm; align-items: stretch; min-height: 47mm; }
.client__text { flex: 1; }
.stamp { flex: none; width: 44mm; border: 0.3mm dashed ${C.deep}; display: flex; align-items: flex-start; justify-content: center; padding-top: 1mm; color: ${C.deep}; font-weight: 700; font-size: 8.6pt; }
.foot { position: absolute; left: 11mm; right: 11mm; bottom: 6mm; display: flex; justify-content: space-between; font-size: 7.4pt; color: ${C.muted}; border-top: 0.25mm solid ${C.hair}; padding-top: 1mm; }
.foot bdi { font-family: Consolas, monospace; color: ${C.deep}; }
/* cover and custody */
.cover h1 { font-size: 22pt; color: ${C.deep}; margin: 18mm 0 2mm; text-align: center; }
.cover .sub { text-align: center; color: ${C.muted}; font-size: 11pt; }
.kv { width: 140mm; margin: 14mm auto 0; }
.kv td { text-align: start; height: 11mm; padding: 0 3mm; font-size: 11pt; }
.kv td:first-child { width: 48mm; color: ${C.deep}; font-weight: 700; }
.kv bdi { font-family: Consolas, monospace; font-size: 13pt; color: ${C.deep}; }
.rules { width: 160mm; margin: 12mm auto 0; font-size: 9.6pt; line-height: 1.8; }
.rules li { margin-bottom: 1mm; }
.custody h1 { text-align: center; color: ${C.deep}; font-size: 18pt; margin: 6mm 0 1mm; }
.custody p { font-size: 11pt; line-height: 2.05; margin-top: 3mm; }
.custody .fill { font-weight: 700; color: ${C.body}; border-bottom: 0.25mm dotted ${C.muted}; padding: 0 1.5mm; }
.custody .fill bdi { font-family: Consolas, monospace; }
.signer { margin-top: 7mm; font-size: 11pt; line-height: 2.4; }
.signer b { color: ${C.deep}; }
.thumb { display: inline-block; width: 26mm; height: 30mm; border: 0.3mm dashed ${C.deep}; vertical-align: top; margin-inline-start: 3mm; }
/* the two zones: the custody zone (A) and the customer zone (B) sit at the same place on every ply */
.zoneA { height: 84mm; margin-top: 2.6mm; padding: 2mm 3mm 2mm; border: 0.3mm solid ${C.hair}; border-inline-start: 0.9mm solid ${C.deep}; display: flex; flex-direction: column; }
.zoneA h3, .zoneB h3 { margin: 0 0 1mm; font-size: 9.6pt; color: ${C.deep}; }
.zoneA p { font-size: 8.2pt; line-height: 1.55; margin-top: 0.8mm; }
.zoneA .law { font-size: 7.6pt; line-height: 1.5; color: ${C.body}; }
.zoneA .sig { margin-top: auto; }
.zoneA--quiet { border-style: dashed; border-inline-start: 0.3mm dashed ${C.hair}; }
.zoneA--quiet .nocopy { margin-top: auto; font-size: 7pt; color: ${C.muted}; text-align: center; }
.zoneB { margin-top: 2.4mm; height: 44mm; padding: 2mm 3mm; border: 0.3mm solid ${C.hair}; border-inline-start: 0.9mm solid ${C.deep}; display: flex; gap: 4mm; }
.zoneB .client__text { flex: 1; display: flex; flex-direction: column; }
.zoneB .client__text .sig { margin-top: auto; }
.zoneB--quiet { border-style: dashed; border-inline-start: 0.3mm dashed ${C.hair}; align-items: center; justify-content: center; color: ${C.muted}; font-size: 8.6pt; text-align: center; }
`;

// the house engine-turned band, identical to house-identity.ts
function band() {
  const w = 6, h = 1.5, mid = h / 2, amp = Number(((mid - 0.26) * (4 / 3)).toFixed(3));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="none" stroke="${C.deep}" stroke-width="0.26"><path d="M0 ${mid}Q1.5 ${Number((mid - amp).toFixed(3))} 3 ${mid}T6 ${mid}"/><path d="M0 ${mid}Q1.5 ${Number((mid + amp).toFixed(3))} 3 ${mid}T6 ${mid}"/></g></svg>`;
  return "url(data:image/svg+xml," + svg.replace(/\s+/g, " ").replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "%22").replace(/'/g, "%27").replace(/ /g, "%20") + ")";
}
const css = CSS.replace("BAND", band());

// ⚖️ DRAFT FOR THE LAWYER'S APPROVAL — the articles named are the ones the research found (Labour Law 14 of 2025:
// art. 134 the duty to keep what the employer hands over, art. 151 paying for what is lost or damaged in custody,
// art. 148 dismissal; Penal Code art. 341 breach of trust). Never add an article number nobody has checked.
const CUSTODY_TEXT = [
  "أقر أنا الموقع أدناه بأنني استلمت من مخازن شركة ساتو فارما، في تاريخ خروجها من المخزن، البضاعة المبينة أعلاه بحالة سليمة ومطابقة للأصناف والتشغيلات والكميات المدونة، بقيمة إجمالية قدرها <span class=\"blank\"></span> جنيه مصري، وذلك على سبيل الأمانة وبصفتي وكيلًا عن الشركة لتسليمها إلى العميل المبين أعلاه دون غيره. وتظل البضاعة ملكًا للشركة وفي عهدتي الشخصية إلى أن أسلّمها للعميل وأسلّم الإدارة المالية الأصل الثاني من هذا الإذن موقعًا ومختومًا منه.",
  "وأتعهد بتسليمها كاملة، وبإعادة ما لم يُسلَّم منها إلى مخزن الشركة، وبرفع صورة هذا الأصل على نظام فينكس خلال ثلاثة أيام، وصورة الأصل الثاني خلال ستة أيام عمل، تبدأ من اليوم التالي لخروج البضاعة من المخزن.",
];
const CUSTODY_LAW = "وأقر بعلمي أن عدم تسليم البضاعة أو ردها أو أداء قيمتها، أو التصرف فيها على غير الوجه المحدد، يُعد اختلاسًا أو تبديدًا لمال سُلِّم إليّ على سبيل الوكالة، يُعاقب عليه بالمادة 341 من قانون العقوبات (خيانة الأمانة) أو غيرها من الجرائم المقررة قانونًا؛ وإخلالًا جسيمًا بالتزامي بالمحافظة على ما تسلّمه إليّ الشركة (المادة 134 من قانون العمل رقم 14 لسنة 2025)، يجيز للشركة مطالبتي بقيمة ما فُقد أو تلف واقتطاعها من أجري في الحدود المقررة بالمادة 151 من القانون ذاته، واتخاذ الإجراءات التأديبية حتى الفصل وفقًا للمادة 148 منه، وذلك كله دون إخلال بحقها في اتخاذ الإجراءات الجنائية والمدنية قِبلي.";

function holderLine(h) {
  if (!h) return `<span class="f__v"></span>`;
  return `<span class="f__v">${esc(h.name)} <small>— ${esc(TITLE_AR[h.title] ?? "مدير منطقة")} · ${esc(h.area)} · ${esc(h.line)}</small></span>`;
}

function receiptPage(book, r, idx, part) {
  const s = r.serial, code = r.code;
  const rows = [1, 2, 3, 4, 5].map((n) => `<tr><td class="n">${n}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join("");
  const h = book.holder;
  const custody = part.kind === "custody";
  // Zone A: on Original 1 the manager's custody, with the law; on Original 2 and the copy the printer desensitizes
  // it, so nothing the manager writes there comes through — it carries only the customer's printed undertaking.
  const zoneA = custody
    ? `<div class="zoneA">
    <h3>إقرار عهدة واستلام بضاعة على سبيل الأمانة — مدير المنطقة</h3>
    <p><b>صاحب العهدة:</b> ${h ? `${esc(h.name)} — ${esc(TITLE_AR[h.title] ?? "مدير منطقة")} · ${esc(h.area)} · ${esc(h.line)}` : `<span class="blank" style="min-width:90mm"></span>`}</p>
    ${CUSTODY_TEXT.map((t) => `<p>${t}</p>`).join("")}
    <p class="law">${CUSTODY_LAW}</p>
    <div class="sig"><div><b>الاسم</b><span></span></div><div><b>الرقم القومي</b><span></span></div><div><b>التوقيع</b><span></span></div></div>
  </div>`
    : `<div class="zoneA zoneA--quiet">
    <h3>إقرار العميل</h3>
    <p>أقر أنا العميل المبين أعلاه (صيدلية / مخزن / حضانة / مستشفى) بأنني استلمت الأصناف المبينة أعلاه كاملة وبحالة سليمة ومطابقة للكميات والتشغيلات المدونة، وأتعهد بسداد قيمتها المبينة أعلاه في حساب الشركة أو لمندوبها المفوض، وفي حالة عدم السداد أُعد خائنًا ومبددًا للأمانة. ويُعد توقيعي وختم المنشأة على هذا الأصل إقرارًا باستلام البضاعة.</p>
    <p class="nocopy">هذا الجزء لا يُنسخ من الأصل الأول</p>
  </div>`;
  const zoneB = custody
    ? `<div class="zoneB zoneB--quiet"><p>يوقّع العميل ويختم على الأصل الثاني (تحت هذه الورقة)، ويحتفظ بالصورة.<br>لا يُنزع هذا الأصل من الدفتر.</p></div>`
    : `<div class="zoneB">
    <div class="client__text">
      <h3>توقيع العميل وختمه (عند التسليم)</h3>
      <div class="sig"><div><b>اسم المستلم</b><span></span></div><div><b>الصفة</b><span></span></div></div>
      <div class="sig"><div><b>التوقيع</b><span></span></div><div><b>تاريخ الاستلام</b><span></span></div></div>
    </div>
    <div class="stamp">ختم المنشأة</div>
  </div>`;
  return `<section class="sheet">
  ${voidPantograph()}
  ${groundSvg(code, s, part.en)}
  <header class="mast">
    <div class="mast__logo">${LOGO}</div>
    <div class="mast__title"><p class="co">شركة ساتو فارما <span dir="ltr">(SATO PHARMA)</span></p><h1>إذن تسليم وتسلم بضاعة</h1></div>
    <div class="mast__sec">${qr(s, code)}${sealSvg(code, s, part.en)}</div>
  </header>
  <div class="band"></div>
  ${microLine(code, s, part.en)}
  <div class="part"><span><b>${part.ar}</b> — ${part.note}</span><span class="meta">دفتر رقم <bdi>${pad(book.book, 2)}</bdi> · إيصال <bdi>${idx + 1}</bdi> من <bdi>${PER_BOOK}</bdi> · رمز التحقق <bdi>${code}</bdi></span></div>
  <div class="f">
    <div class="f__row f__row--half"><span class="f__l">رقم الإذن:</span><span class="f__v f__v--serial" dir="ltr">${pad(s)}</span></div>
    <div class="f__row f__row--half"><span class="f__l">التاريخ:</span><span class="date">..... / ..... / 20.....</span></div>
    <div class="f__row"><span class="f__l">جهة الصرف (المخزن)</span><span class="f__v">ساتو فارما</span></div>
    <div class="f__row"><span class="f__l">العميل (صيدلية / مخزن / حضانة / مستشفى) والعنوان</span><span class="f__v"></span></div>
  </div>
  <div class="sec">بيان الأصناف المسلمة:</div>
  <table>
    <colgroup><col style="width:7%"><col style="width:27%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:10%"><col style="width:14%"></colgroup>
    <thead><tr><th>م</th><th>اسم الصنف</th><th>رقم التشغيلة (Batch)</th><th>تاريخ الصلاحية (EXP)</th><th>الوحدة (علبة / كرتونة)</th><th>الكمية</th><th>القيمة</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="total"><span>إجمالي عدد الكراتين: (</span><span class="gap"></span><span>) — القيمة الإجمالية فقط وقدرها</span><span class="wide"></span></div>
  ${zoneA}
  ${zoneB}
  <div class="foot"><span>${part.ar} — ${part.note}</span><span>رقم الإذن <bdi>${pad(s)}</bdi> · رمز التحقق <bdi>${code}</bdi></span></div>
</section>`;
}

function coverPage(book) {
  const h = book.holder;
  return `<section class="sheet cover">
  <header class="mast"><div class="mast__logo">${LOGO}</div><div class="mast__title"><p class="co">شركة ساتو فارما <span dir="ltr">(SATO PHARMA)</span></p></div><div style="width:36mm"></div></header>
  <div class="band"></div>
  <h1>دفتر أذون تسليم وتسلم بضاعة</h1>
  <p class="sub">عهدة شخصية مستردة — يُسلَّم بكامل كعوبه وأوراقه عند إخلاء الطرف</p>
  <table class="kv"><tbody>
    <tr><td>رقم الدفتر</td><td><bdi>${pad(book.book, 2)}</bdi></td></tr>
    <tr><td>عدد الإيصالات</td><td><bdi>${PER_BOOK}</bdi> إيصال — كل إيصال أصلان وصورة</td></tr>
    <tr><td>من رقم</td><td><bdi>${pad(book.first)}</bdi></td></tr>
    <tr><td>إلى رقم</td><td><bdi>${pad(book.last)}</bdi></td></tr>
    <tr><td>صاحب العهدة</td><td>${h ? esc(h.name) : ""}</td></tr>
    <tr><td>الوظيفة</td><td>${h ? esc(TITLE_AR[h.title] ?? "مدير منطقة") : ""}</td></tr>
    <tr><td>المنطقة / الخط</td><td>${h ? `${esc(h.area)} — ${esc(LINE_AR[h.line] ?? h.line)}` : ""}</td></tr>
    <tr><td>تاريخ الاستلام</td><td>..... / ..... / 20..... م</td></tr>
  </tbody></table>
  <ol class="rules">
    <li>كل إيصال يحمل رقم إذن مسلسلاً ورمز تحقق وختماً هندسياً خاصاً به لا يتكرر في أي إيصال آخر، وتطبع العلامة المائية نفسها في خلفية الإيصال.</li>
    <li>الإيصال الذي لا يطابق رقمه ورمزه وختمه سجل الشركة، أو به كشط أو تعديل في رقم الإذن، لا يُعتد به إثباتاً للتسليم.</li>
    <li>الأصل الأول (إقرار العهدة) لا يُنزع من الدفتر. الأصل الثاني يوقّعه العميل ويختمه، وينزعه مدير المنطقة ويرسله للمالية. صورة العميل تُنزع وتُسلَّم للعميل.</li>
    <li>يُرفع الأصل الأول على فينكس خلال 3 أيام، والأصل الثاني خلال 6 أيام عمل (عدا الجمعة)، من اليوم التالي لخروج البضاعة من المخزن.</li>
    <li>الإيصال الملغى يبقى في الدفتر بأصليه وصورته ويُكتب عليه «ملغى» بتوقيع صاحب العهدة.</li>
    <li>توقيع مدير المنطقة على الأصل الأول، وتوقيع العميل وختمه على الأصل الثاني، شرط لاعتماد الإيصال إثباتاً للتسليم.</li>
  </ol>
  <div class="foot"><span>دفتر رقم <bdi>${pad(book.book, 2)}</bdi></span><span>من <bdi>${pad(book.first)}</bdi> إلى <bdi>${pad(book.last)}</bdi></span></div>
</section>`;
}

function custodyPage(book) {
  const h = book.holder;
  const f = (v, w = 60) => (v ? `<span class="fill">${esc(v)}</span>` : `<span class="fill" style="display:inline-block;min-width:${w}mm"></span>`);
  const fb = (v) => `<span class="fill"><bdi dir="ltr">${esc(v)}</bdi></span>`;
  return `<section class="sheet custody">
  <header class="mast"><div class="mast__logo">${LOGO}</div><div class="mast__title"><p class="co">شركة ساتو فارما <span dir="ltr">(SATO PHARMA)</span></p></div><div style="width:36mm"></div></header>
  <div class="band"></div>
  <h1>إقرار استلام عهدة (دفتر إيصالات)</h1>
  <p>أقر أنا الموقع أدناه / ${f(h?.name, 80)} المقيم في / ${f(h?.addr, 90)} والحامل لبطاقة رقم قومي / ${h ? fb(h.nid) : f(null, 55)} والعامل بوظيفة / ${f(h ? TITLE_AR[h.title] ?? "مدير منطقة" : null, 40)} لدى شركة ساتوفارما.</p>
  <p>بأنني قد استلمت اليوم الموافق: ..... / ..... / 20..... م، من إدارة الشركة وبصفة عهدة شخصية:</p>
  <p>عدد ( ${fb("1")} ) دفتر إيصالات، يحتوي على عدد ( ${fb(String(PER_BOOK))} ) إيصال مرقمين ومُسلسلين تسلسلاً رقمياً متتابعاً يبدأ من الرقم ( ${fb(pad(book.first))} ) وينتهي عند الرقم ( ${fb(pad(book.last))} )، وذلك لاستخدامه في مهام عملي المكلف بها.</p>
  <p>وأتعهد بالمحافظة على هذا الدفتر وكافة أصوله وصوره، واستخدامه في الأغراض المخصصة له من قِبل الشركة فقط، وعدم التصرف فيه أو إتلافه أو التلاعب ببياناته. كما ألتزم بتقديم كشف حساب وتوريد كافة المتحصلات أو المستندات الخاصة به أولاً بأول وفقاً للوائح الشركة.</p>
  <p>كما أتعهد التزاماً قاطعاً بتسليم هذا الدفتر (كعهدة مستردة بكافة كعوبه وأوراقه المستخدمة وغير المستخدمة) إلى الإدارة المختصة فور طلبه مني، أو عند انتهاء علاقة عملي بالشركة لأي سبب من الأسباب، ويُعد تسليم هذه العهدة ومراجعتها شرطاً أساسياً ولازماً لإتمام إجراءات إخلاء طرفي وصرف مستحقاتي المالية.</p>
  <p>وفي حالة فقدان الدفتر أو أي ورقة من أوراقه أو التقصير في تسليمه، أتحمل كامل المسؤولية القانونية والمدنية والجنائية المترتبة على ذلك، ويحق للشركة اتخاذ كافة الإجراءات القانونية اللازمة قِبلي لحفظ حقوقها.</p>
  <p>وهذا إقرار مني بذلك للعمل بموجبه،،،</p>
  <div class="signer">
    <b>المُقِر بما فيه:</b><br>
    <b>الاسم بالكامل:</b> ....................................................<br>
    <b>التوقيع:</b> ..............................................................<br>
    <b>البصمة (إبهام اليد اليمنى):</b> <span class="thumb"></span><br>
    <b>تاريخ الاستلام:</b> ..... / ..... / 20..... م
  </div>
  <div class="foot"><span>دفتر رقم <bdi>${pad(book.book, 2)}</bdi></span><span>من <bdi>${pad(book.first)}</bdi> إلى <bdi>${pad(book.last)}</bdi></span></div>
</section>`;
}

const doc = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--disable-extensions"] });
async function toPdf(html, file, shots = []) {
  const page = await browser.newPage();
  // a 150-page book with 450 seals can take minutes on a busy laptop: Puppeteer's 30 s default stopped book 10 on 27 Nov
  await page.setContent(html, { waitUntil: "load", timeout: 300000 });
  await page.evaluateHandle("document.fonts.ready");
  await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true, timeout: 300000 });
  if (shots.length) {
    await page.emulateMediaType("print");
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    for (const [i, shot] of shots) {
      const el = (await page.$$("section.sheet"))[i];
      await el.screenshot({ path: shot });
    }
  }
  // overflow check: anything spilling past its sheet
  const spill = await page.evaluate(() => [...document.querySelectorAll("section.sheet")].map((s, i) => {
    const sb = s.getBoundingClientRect(); let worst = 0;
    s.querySelectorAll("*").forEach((e) => { if (e.closest(".wm")) return; const b = e.getBoundingClientRect(); if (b.height) worst = Math.max(worst, b.bottom - sb.bottom); });
    return worst > 0.5 ? i : null;
  }).filter((x) => x !== null));
  await page.close();
  return spill;
}

const books = SAMPLE ? register.slice(0, 1) : register;
const report = [];
let custodySpill = null;
try {
for (const book of books) {
  const receipts = SAMPLE ? book.receipts.slice(0, 2) : book.receipts;
  const body = [coverPage(book), ...receipts.flatMap((r, i) => PARTS.map((p) => receiptPage(book, r, i, p)))].join("\n");
  const who = book.holder ? `${book.holder.area} - ${book.holder.line}` : "Spare";
  const file = path.join(OUT, `Receipt Book ${pad(book.book, 2)} - ${who} - ${pad(book.first)}-${pad(book.last)}.pdf`);
  const shots = !SAMPLE && book.book === 1 ? [[0, path.join(OUT, "preview-cover.png")], [1, path.join(OUT, "preview-original1.png")], [2, path.join(OUT, "preview-original2.png")], [4, path.join(OUT, "preview-next-receipt.png")]] : [];
  const spill = await toPdf(doc(`دفتر ${book.book}`, body), file, shots);
  report.push({ book: book.book, file: path.basename(file), pages: 1 + receipts.length * 3, spill });
}
// the custody pages carry national IDs and addresses, and the register every code: never in a sample folder
if (!SAMPLE) custodySpill = await toPdf(doc("إقرار استلام عهدة", register.map(custodyPage).join("\n")), path.join(OUT, "Book Custody Acknowledgements - all books.pdf"), [[0, path.join(OUT, "preview-custody.png")]]);
} finally {
  await browser.close();
}

if (!SAMPLE) {

// the register workbook
const wb = new ExcelJS.Workbook();
const ws1 = wb.addWorksheet("Books");
ws1.columns = [{ header: "Book", key: "b", width: 7 }, { header: "Holder", key: "n", width: 32 }, { header: "HR ID", key: "h", width: 10 }, { header: "Job title", key: "t", width: 24 }, { header: "Line", key: "l", width: 16 }, { header: "Area", key: "a", width: 16 }, { header: "First serial", key: "f", width: 12 }, { header: "Last serial", key: "z", width: 12 }, { header: "Handed over on", key: "d", width: 16 }, { header: "Returned on", key: "r", width: 14 }];
for (const b of register) ws1.addRow({ b: b.book, n: b.holder?.name ?? "SPARE — not assigned", h: b.holder?.hr_id ?? "", t: b.holder?.title ?? "", l: b.holder?.line ?? "", a: b.holder?.area ?? "", f: pad(b.first), z: pad(b.last) });
const ws2 = wb.addWorksheet("Receipts");
ws2.columns = [{ header: "Serial", key: "s", width: 10 }, { header: "Check code", key: "c", width: 12 }, { header: "Book", key: "b", width: 7 }, { header: "Holder", key: "n", width: 32 }, { header: "Used on direct order", key: "o", width: 22 }, { header: "Status", key: "st", width: 14 }];
for (const b of register) for (const r of b.receipts) ws2.addRow({ s: pad(r.serial), c: r.code, b: b.book, n: b.holder?.name ?? "SPARE", st: "Unused" });
for (const ws of [ws1, ws2]) { ws.getRow(1).font = { bold: true }; ws.views = [{ state: "frozen", ySplit: 1 }]; }
await wb.xlsx.writeFile(path.join(OUT, "Receipt Book Register.xlsx"));
}

console.log(JSON.stringify({ report, custodySpill }, null, 1));
