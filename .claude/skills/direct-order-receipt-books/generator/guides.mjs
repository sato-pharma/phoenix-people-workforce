// Two Arabic explainers for the direct-order receipt books (owner, 27 Nov 2026):
//   1. a short summary for Finance and the Chairman — what the system does, the controls, who does what;
//   2. the working guide for the District Managers — the paper, then Phoenix, step by step.
// House identity (SATO-DIS-2026-01): the on-light logo, the three blues, the engine-turned band, the ink
// rule (no filled area but the 6% zebra), square edges. No real receipt code appears in either document.
// Usage: node guides.mjs <outDir>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// generator/ -> direct-order-receipt-books/ -> skills/ -> .claude/ -> the repo. PHOENIX_REPO overrides (the _generator copy outside the repo).
const REPO = process.env.PHOENIX_REPO ?? path.resolve(HERE, "../../../..");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const require = createRequire(REPO + "/package.json");
const puppeteer = require("puppeteer-core");
const { PDFDocument } = require("pdf-lib");

// The owner, 27 Nov 2026: receiving a book is optional, and a manager who has not received one may raise no direct order at all.
const OPTIONAL_AR = "استلام الدفاتر اختياري، وفي حالة عدم الاستلام لا يحق للمدير عمل أي أوردر بيع مباشر نهائيًا.";
const OUT = process.argv[2];
if (!OUT) { console.error("Usage: node guides.mjs <Guides folder>"); process.exit(1); }
// the sample book (build.mjs --sample, copied into the Guides folder): its page 2, receipt 1's Original, is the copier test's page 2
const SAMPLE_PDF = path.join(OUT, "عينة دفتر - دفتر 01 القاهرة - إيصالان للعرض.pdf");
const missing = [path.join(OUT, "_img", "desk-top.png"), path.join(OUT, "_img", "desk-bottom.png"), SAMPLE_PDF].filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error(["Missing, needed before the guides can be built:", ...missing.map((f) => "  " + f),
    "The two screenshots are Finance's Receipt Books desk (SKILL.md, The guides); the sample is build.mjs --sample."].join("\n"));
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const C = { deep: "#0A527D", blue: "#0A6BA6", light: "#1482C2", zebra: "#F2F6FA", hair: "#B9C7D4", muted: "#5A6B7C", body: "#1A1A1A" };
const FONT = '"Tahoma", "Segoe UI", "Traditional Arabic", "Noto Sans Arabic", Arial, sans-serif';
const LOGO = fs.readFileSync(REPO + "/public/brand/sato-pharma-logo-on-light.svg", "utf8")
  .replace(/<\?xml[^>]*>/, "").replace(/<title>.*?<\/title>/, "")
  .replace(/width="401" height="158"/, 'width="100%" height="100%"');

function band() {
  const w = 6, h = 1.5, mid = h / 2, amp = Number(((mid - 0.26) * (4 / 3)).toFixed(3));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="none" stroke="${C.deep}" stroke-width="0.26"><path d="M0 ${mid}Q1.5 ${Number((mid - amp).toFixed(3))} 3 ${mid}T6 ${mid}"/><path d="M0 ${mid}Q1.5 ${Number((mid + amp).toFixed(3))} 3 ${mid}T6 ${mid}"/></g></svg>`;
  return "url(data:image/svg+xml," + svg.replace(/\s+/g, " ").replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "%22").replace(/'/g, "%27").replace(/ /g, "%20") + ")";
}

const CSS = `
@page { size: A4; margin: 13mm 14mm 17mm; }
* { box-sizing: border-box; border-radius: 0; }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${FONT}; color: ${C.body}; font-size: 10.2pt; line-height: 1.75; direction: rtl; }
.mast { display: flex; direction: ltr; align-items: center; gap: 5mm; }
.mast__logo { width: 34mm; height: 13.4mm; flex: none; }
.mast__title { flex: 1; text-align: right; direction: rtl; }
.mast__title .co { margin: 0; font-size: 9.6pt; font-weight: 700; color: ${C.deep}; }
.mast__title .co span { font-family: Aptos, "Segoe UI", sans-serif; letter-spacing: 0.06em; }
.mast__title .aud { margin: 0.4mm 0 0; font-size: 8.6pt; color: ${C.muted}; }
.band { height: 1.5mm; margin: 2.6mm 0 0; background: ${band()} center / 6mm 1.5mm repeat-x; }
h1 { font-size: 19pt; color: ${C.deep}; margin: 7mm 0 1mm; line-height: 1.35; }
.lead { margin: 0 0 5mm; font-size: 11pt; color: #33414F; }
h2 { font-size: 12.6pt; color: ${C.deep}; margin: 6.5mm 0 2mm; padding-bottom: 1mm; border-bottom: 0.3mm solid ${C.deep}; break-after: avoid; page-break-after: avoid; }
h2 .n { display: inline-block; min-width: 7mm; color: ${C.light}; font-family: Consolas, monospace; }
p { margin: 0 0 2.4mm; }
ul, ol { margin: 0 0 2.4mm; padding-inline-start: 6mm; }
li { margin-bottom: 1.2mm; }
b, strong { color: #0F2A3D; }
.ui { font-family: "Segoe UI", Aptos, Arial, sans-serif; font-weight: 700; color: ${C.deep}; unicode-bidi: isolate; direction: ltr; display: inline-block; border-bottom: 0.25mm solid ${C.hair}; padding: 0 0.6mm; line-height: 1.3; }
bdi.num { font-family: Consolas, monospace; color: ${C.deep}; }
table { width: 100%; border-collapse: collapse; margin: 1mm 0 3mm; font-size: 9.6pt; line-height: 1.6; break-inside: auto; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { text-align: start; color: ${C.deep}; font-weight: 700; border-bottom: 0.4mm solid ${C.deep}; padding: 1.6mm 2.4mm; vertical-align: bottom; }
td { padding: 1.8mm 2.4mm; border-bottom: 0.2mm solid ${C.hair}; vertical-align: top; }
tbody tr:nth-child(even) td { background: ${C.zebra}; }
td.k { font-weight: 700; color: #0F2A3D; width: 34%; }
.ok { color: ${C.deep}; font-weight: 700; }
.note { border-inline-start: 1mm solid ${C.deep}; padding: 1mm 4mm; margin: 3mm 0; break-inside: avoid; }
.note p:last-child { margin-bottom: 0; }
.steps { counter-reset: s; list-style: none; padding: 0; margin: 0 0 3mm; }
.steps > li { counter-increment: s; position: relative; padding-inline-start: 11mm; margin-bottom: 2.6mm; break-inside: avoid; }
.steps > li::before { content: counter(s); position: absolute; inset-inline-start: 0; top: 0.2mm; width: 7.4mm; height: 7.4mm; border: 0.35mm solid ${C.deep}; color: ${C.deep}; font-family: Consolas, monospace; font-weight: 700; font-size: 10.5pt; line-height: 6.8mm; text-align: center; }
.steps > li b.t { display: block; color: ${C.deep}; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
@media (max-width: 0) {}
.sample { border: 0.3mm solid ${C.deep}; padding: 3mm 4mm; margin: 2mm 0 3mm; break-inside: avoid; }
.sample .row { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.sample .meta { font-size: 9pt; color: ${C.muted}; }
.sample .serial { font-family: Consolas, monospace; font-size: 15pt; color: ${C.deep}; letter-spacing: 0.08em; border-bottom: 0.3mm solid ${C.deep}; padding: 0 2mm; }
.sample .code { font-family: Consolas, monospace; color: ${C.deep}; font-weight: 700; letter-spacing: 0.08em; }
.sample .tag { font-size: 8.2pt; color: ${C.deep}; font-weight: 700; border: 0.25mm solid ${C.deep}; padding: 0 1.6mm; margin-inline-start: 2mm; }
.sample .cap { margin-top: 2.4mm; font-size: 8.6pt; color: ${C.muted}; border-top: 0.2mm solid ${C.hair}; padding-top: 1.6mm; }
.keep { break-inside: avoid; page-break-inside: avoid; }
figure.shot { margin: 2mm auto 3.5mm; break-inside: avoid; }
figure.shot img { display: block; width: 100%; border: 0.25mm solid ${C.hair}; }
figure.shot figcaption, .screen-cap { font-size: 8.4pt; color: ${C.muted}; margin-top: 1.2mm; }
.screen { direction: ltr; width: 150mm; margin: 3mm auto 1mm; border: 0.3mm solid #CBD5E1; background: #fff; font-family: "Segoe UI", Aptos, Arial, sans-serif; break-inside: avoid; }
.screen .bandx { background: #0B1424; color: #fff; font-size: 7.4pt; font-weight: 800; letter-spacing: 0.12em; padding: 2.2mm 4mm; }
.screen .body { padding: 3.4mm 4mm 4mm; font-size: 8.6pt; color: #334155; line-height: 1.5; }
.screen .body p { margin: 0 0 2.4mm; }
.screen .rule { border-top: 0.25mm solid #E2E8F0; padding-top: 2.6mm; }
.screen .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; margin-bottom: 2.6mm; }
.screen label { display: block; font-size: 6.8pt; font-weight: 800; letter-spacing: 0.08em; color: #475569; text-transform: uppercase; margin-bottom: 0.8mm; }
.screen label i { color: #E11D48; font-style: normal; }
.screen .inp { border: 0.3mm solid #CBD5E1; height: 8mm; padding: 0 2.4mm; display: flex; align-items: center; color: #94A3B8; font-size: 8.6pt; }
.screen .inp.code { letter-spacing: 0.2em; }
.screen .hint { font-size: 7pt; color: #64748B; margin-top: 0.6mm; }
.screen .btns { display: flex; gap: 2mm; margin-bottom: 2.6mm; }
.screen .ghost { border: 0.3mm solid #CBD5E1; padding: 1.6mm 3mm; font-size: 8pt; font-weight: 700; color: #0F172A; }
.screen .accent { background: #F05A1A; color: #fff; text-align: center; font-size: 8.6pt; font-weight: 700; padding: 2.2mm; }
.callouts { display: grid; grid-template-columns: 1fr 1fr; gap: 1mm 6mm; width: 150mm; margin: 0 auto 3mm; font-size: 8.8pt; }
.callouts b { color: ${C.deep}; font-family: Consolas, monospace; }
h2.pb { break-before: page; page-break-before: always; margin-top: 0; }
`;

const IMG = (f) => "data:image/png;base64," + fs.readFileSync(path.join(OUT, "_img", f)).toString("base64");
const shot = (f, cap, w = 150) => `<figure class="shot" style="width:${w}mm"><img src="${IMG(f)}" alt=""><figcaption>${cap}</figcaption></figure>`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ui = (s) => `<span class="ui">${esc(s)}</span>`;
const n = (s) => `<bdi class="num">${esc(s)}</bdi>`;
const mast = (aud) => `<header class="mast"><div class="mast__logo">${LOGO}</div><div class="mast__title"><p class="co">شركة ساتو فارما <span dir="ltr">(SATO PHARMA)</span></p><p class="aud">${aud}</p></div></header><div class="band"></div>`;
const doc = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

// ── 1 · Finance and the Chairman ────────────────────────────────────────────────────────────────
const management = doc("دفاتر إيصالات الطلبات المباشرة — ملخص للإدارة", `
${mast("ملخص للإدارة — الإدارة العليا والمالية")}
<h1>دفاتر إيصالات الطلبات المباشرة</h1>
<p class="lead">كل طلب مباشر يُعتمد على فينيكس يجب أن يثبت وصوله للعميل بإيصال مطبوع، موقّع ومختوم، <b>لا يمكن تزويره ولا استخدامه مرتين</b>. فينيكس هو الذي يتحقق من كل إيصال، وليس مراجعة الورق باليد.</p>

<h2><span class="n">1</span>ما تم تجهيزه</h2>
<table><tbody>
<tr><td class="k">الدفاتر</td><td>${n("16")} دفتراً × ${n("50")} إيصالاً = ${n("800")} إيصال، مرقّمة من ${n("000001")} إلى ${n("000800")}.</td></tr>
<tr><td class="k">لمن</td><td>${n("14")} دفتراً مطبوع على إقرار العهدة في كل إيصال منها اسم مدير المنطقة صاحبه، ودفتران احتياطيان (لمدير جديد أو منطقة بلا دفتر).</td></tr>
<tr><td class="k">الاستلام</td><td><b>${OPTIONAL_AR}</b></td></tr>
<tr><td class="k">الإيصال</td><td><b>أصلان وصورة.</b> الأصل الأول إقرار عهدة يوقّعه المدير عند خروج البضاعة: البضاعة أمانة في عهدته، وعدم تسليمها خيانة أمانة، والمواد القانونية مطبوعة عليه. الأصل الثاني يوقّعه العميل ويختمه، ولا يحمل بيانات المدير، وصورته الكربونية للعميل. يحمل كل إيصال رقماً مسلسلاً، و<b>رمز تحقق</b> من ${n("6")} حروف وأرقام مطبوعاً بجوار الرقم، وكوداً وختماً خاصاً به لا يتكرر.</td></tr>
<tr><td class="k">العهدة</td><td>كل دفتر عهدة شخصية مستردة بإقرار موقّع وبصمة، ويُرد بكامل أوراقه عند الطلب أو عند ترك العمل، كشرط لإخلاء الطرف.</td></tr>
<tr><td class="k">على فينيكس</td><td>الدفاتر الـ${n("16")} والإيصالات الـ${n("800")} ورموزها مسجّلة على النظام ويعمل التحقق بها من الآن. الرموز موجودة في النظام وعلى الورق المطبوع فقط.</td></tr>
</tbody></table>

<h2><span class="n">2</span>ما يمنعه فينيكس تلقائياً</h2>
<table>
<thead><tr><th style="width:44%">المحاولة</th><th>ما يحدث</th></tr></thead>
<tbody>
<tr><td>إيصال مطبوع خارج الشركة أو رقم مخترع</td><td><span class="ok">مرفوض</span> — رمز التحقق لا يطابق رقم الإيصال.</td></tr>
<tr><td>استخدام نفس الإيصال (أو صورة ضوئية منه) لطلب ثانٍ</td><td><span class="ok">مرفوض</span> — كل إيصال يُثبت طلباً واحداً فقط وإلى الأبد، حتى لو ضغط شخصان في نفس اللحظة.</td></tr>
<tr><td>إيصال من دفتر مدير آخر</td><td><span class="ok">مرفوض</span> — الإيصال يجب أن يكون من دفتر من رفع الطلب.</td></tr>
<tr><td>إيصال من دفتر لم تسلّمه المالية بعد، أو فُقد</td><td><span class="ok">مرفوض</span>.</td></tr>
<tr><td>إيصال من دفتر أُعيد للمالية</td><td>يُقبل فقط لطلب اعتُمد والدفتر في عهدة المدير؛ أي طلب اعتُمد بعد الإعادة <span class="ok">مرفوض</span>.</td></tr>
<tr><td>فقدان دفتر</td><td>تُلغى كل إيصالاته غير المستخدمة فوراً عند تسجيل الفقد، والمستخدمة تظل تثبت طلباتها.</td></tr>
<tr><td>إلغاء إيصال سبق استخدامه في طلب</td><td><span class="ok">غير مسموح</span>.</td></tr>
<tr><td>أصل لم يُدخل في موعده</td><td>المواعيد من اليوم التالي لخروج البضاعة من المخزن كما سجّلته المالية: <b>الأصل الأول خلال ${n("3")} أيام، والأصل الثاني خلال ${n("6")} أيام عمل</b> (عدا الجمعة). بعد الموعد يظهر الطلب متأخراً عند المالية، و<b>لا يرفع مديره أي طلب جديد</b>، ولا يُعتمد نهائياً أي طلب له ينتظر الاعتماد، حتى يُدخله.</td></tr>
<tr><td>أصل ثانٍ من إيصال آخر، أو قبل الأصل الأول</td><td><span class="ok">مرفوض</span> — الأصل الثاني يُضاف على نفس الإيصال مرة واحدة، بعد الأصل الأول.</td></tr>
<tr><td>طلب لصيدلية لم تسدد شيئاً من طلب سابق من نفس الصنف</td><td><span class="ok">مرفوض</span> — عند رفع الطلب وعند الاعتماد الأخير، حتى بموافقة. طلب صنف آخر لنفس الصيدلية يُرفع عادي.</td></tr>
<tr><td>صيدلية سددت جزءاً من طلب سابق من نفس الصنف، أو تأخرت عن ميعاد السداد في أي طلب</td><td>يكمل الطلب دورة الموافقات، و<b>الاعتماد الأخير لدكتور أنور وحده</b>.</td></tr>
<tr><td>طلب يمشي بدون إيصال</td><td>فقط <b>بموافقة دكتور أنور على فينيكس</b>: المالية (أحمد المراغي) تطلبها من صفحة الطلب مع كتابة السبب، ودكتور أنور وحده يوافق أو يرفض.</td></tr>
<tr><td>طلب رفعه شخص لا يحمل دفتراً</td><td>يظهر عند المالية فوراً كطلب <b>بلا دفتر</b>، فلا يمر طلب بلا إيصال دون أن يُرى.</td></tr>
<tr><td>إيصال أُدخل على الطلب الخطأ</td><td>المالية وحدها ترفعه عن الطلب مع كتابة السبب، ويبقى السبب والصورة ومن أدخله مسجّلاً على الطلب، ويعود الإيصال صالحاً للطلب الصحيح.</td></tr>
</tbody></table>
<p>كل محاولة مرفوضة تُسجَّل على الطلب نفسه، بمن حاولها ومتى وسبب الرفض.</p>
<div class="keep"><h2><span class="n">3</span>حماية الورق نفسه — مطبوعة في كل صفحة</h2>
<table>
<thead><tr><th style="width:30%">العلامة</th><th>ما تفعله</th></tr></thead>
<tbody>
<tr><td class="k">ورق أمان ضد التصوير</td><td>الأصلان يُطبعان على ورق أمان جاهز ضد النسخ (VOID). الأصل يبدو ورقة عادية، <b>وعلى أي صورة ضوئية أو سكانر تظهر كلمة تكشف أنها نسخة</b>. العلامة في الورق نفسه، تأتي به المطبعة جاهزاً. صورة العميل على ورق عادي.</td></tr>
<tr><td class="k">رقم الإذن بالأحمر</td><td>رقم الإذن مطبوع بالأحمر، وكل توقيع على الإيصال بالقلم الأزرق.</td></tr>
<tr><td class="k">ختم هندسي لكل إيصال</td><td>زخرفة دائرية يُرسم شكلها من رقم الإيصال ورمزه، فلا يتشابه ختمان في الـ${n("800")} إيصال، وحول الختم الرقم والرمز مكتوبان.</td></tr>
<tr><td class="k">علامة مائية ظاهرة</td><td>نفس الختم مكبّراً وباهتاً خلف جدول الأصناف.</td></tr>
<tr><td class="k">سطر مجهري</td><td>سطر يبدو خطاً رفيعاً، وهو بالعدسة اسم الشركة ورقم الإيصال ورمزه مكرراً.</td></tr>
<tr><td class="k">رمز QR</td><td>يحمل رقم الإيصال ورمز التحقق.</td></tr>
<tr><td class="k">اسم صاحب الدفتر</td><td>مطبوع على الأصل الأول وحده (إقرار العهدة)، ولا يظهر على أصل العميل ولا صورته. وكل صفحة تحمل اسمها: «الأصل الأول» أو «الأصل الثاني» أو «صورة العميل».</td></tr>
</tbody></table></div>
<p>ورق الأمان يكشف النسخة على الورق. والذي يمنع استخدام أي نسخة في كل الأحوال هو فينيكس: كل إيصال برقمه ورمزه يُقبل لطلب واحد فقط.</p>
<p>شرط الطباعة: يُطبع الأصلان على ورق أمان جاهز ضد النسخ (VOID)، وتُطبع الملفات كما هي بالحجم الفعلي، ويُصوَّر إيصال من البروفة على ماكينة تصوير قبل طباعة الكمية للتأكد من ظهور كلمة الكشف على الصورة.</p>

<h2><span class="n">4</span>من يفعل ماذا</h2>
<table>
<thead><tr><th style="width:26%">الدور</th><th>المسؤولية</th></tr></thead>
<tbody>
<tr><td class="k">مدير المنطقة</td><td>يملأ الإيصال عند استلام البضاعة من المخزن ويوقّع إقرار العهدة على الأصل الأول، ويحصل على توقيع العميل وختمه على الأصل الثاني عند التسليم، ثم يُدخل الأصلين على الطلب في فينيكس، كلٌّ في موعده، ويرسل الأصل الثاني للمالية.</td></tr>
<tr><td class="k">المالية — أحمد المراغي</td><td>تسلّم الدفاتر بإقرار العهدة وتسجّل التسليم على فينيكس، <b>وتسجّل يوم خروج بضاعة كل طلب من المخزن</b> — ومنه تبدأ المواعيد. تستلم من المديرين الأصل الثاني من كل إيصال، وتطبع من فينيكس صفحة «تم التحقق» بالأصلين لملفها، وتسترد الدفاتر، وتسجّل المفقود، وتلغي الإيصال التالف، وتتابع المتأخر، وتطلب من دكتور أنور الموافقة على أي طلب يمشي بدون إيصال. يمكنها أيضاً إدخال الأصلين بدلاً من المدير.</td></tr>
<tr><td class="k">دكتور أنور — الرئيس التنفيذي</td><td>وحده يوافق على طلب يمشي بدون إيصال أو يرفضه، ووحده يعتمد نهائياً طلب صيدلية سددت جزءاً أو تأخرت عن ميعاد السداد.</td></tr>
<tr><td class="k">الإدارة</td><td>تطّلع على السجل كاملاً: كل إيصال، على أي طلب، ومن أدخله ومتى.</td></tr>
</tbody></table>

<h2><span class="n">5</span>دورة العمل باختصار</h2>
<ol class="steps">
<li><b class="t">المالية تسلّم الدفتر</b>يوقّع المدير إقرار العهدة، وتضغط المالية ${ui("Hand to")} ومعه اسم المدير على فينيكس في نفس اليوم. من هذا اليوم تبدأ مطالبة المدير بالإيصالات.</li>
<li><b class="t">الطلب يُعتمد على فينيكس</b>كما هو معمول به الآن، بدون أي تغيير في دورة الموافقات.</li>
<li><b class="t">خروج البضاعة من المخزن</b>يستلم المدير البضاعة، ويملأ الإيصال، ويوقّع إقرار العهدة على <b>الأصل الأول</b>: البضاعة أمانة في عهدته حتى يسلّمها. تسجّل المالية يوم الخروج على فينيكس.</li>
<li><b class="t">التسليم للعميل</b>يوقّع العميل ويختم على <b>الأصل الثاني</b>، ويأخذ <b>صورة العميل</b>. الأصل الأول يبقى في الدفتر، والأصل الثاني ينزعه المدير ويرسله للمالية.</li>
<li><b class="t">الإدخال على فينيكس</b>لكل أصل: رقم الإيصال + رمز التحقق + صورته. الأصل الأول خلال ${n("3")} أيام، والأصل الثاني خلال ${n("6")} أيام عمل (عدا الجمعة)، من اليوم التالي لخروج البضاعة. فينيكس يتحقق في الحال ويقبل أو يرفض.</li>
<li><b class="t">المتابعة</b>أي أصل فات موعده يظهر بالأحمر على شاشة المالية، ولا يرفع مديره طلباً جديداً حتى يُدخله.</li>
</ol>

<div class="note keep">
<p><b>ملاحظات مهمة</b></p>
<ul>
<li><b>${OPTIONAL_AR}</b></li>
<li>الطلبات التي اعتُمدت <b>قبل</b> استلام المدير لدفتره لا يُطلب لها إيصال.</li>
<li>لا يُحسب أي موعد قبل أن تسجّل المالية يوم خروج البضاعة من المخزن.</li>
<li>صورة الأصل المرفوعة على فينيكس ليست أصلاً، لذلك تطبع المالية لملفها صفحة «تم التحقق على فينيكس» بدلاً من طباعة الصورة.</li>
<li>الإيصال <b>لا يوقف</b> احتساب المبيعات في الشهر ولا تسجيل التحصيل. الذي يوقفه الإيصال المتأخر هو <b>طلبات مديره الجديدة</b>.</li>
<li>لا يحمل دفتراً حالياً: المدير المستقيل، ومدير المبيعات القومي (طلباته نادرة). يُستخدم الاحتياطي عند الحاجة.</li>
</ul>
</div>

<h2><span class="n">6</span>شاشة المالية على فينيكس</h2>
<p>من القائمة: ${ui("Direct Orders")} ← ${ui("Receipt Books")}. تظهر لأحمد المراغي ولمدير النظام فقط.</p>
${shot("desk-top.png", "الشاشة الحقيقية على فينيكس اليوم: الدفاتر كلها «مع المالية» (With Finance)، وبجوار كل دفتر زر التسليم لصاحبه.", 108)}
<table>
<thead><tr><th style="width:34%">الجزء</th><th>الاستخدام</th></tr></thead>
<tbody>
<tr><td class="k">${ui("Waiting for the warehouse exit")}</td><td>الطلبات المعتمدة التي لم يُسجَّل يوم خروج بضاعتها. يُسجَّل اليوم من نفس السطر بزر ${ui("Record the exit")}، ويُصحَّح بزر ${ui("Correct the day")}.</td></tr>
<tr><td class="k">${ui("Approved with no receipt")}</td><td>الطلبات التي خرجت بضاعتها ولم يكتمل إيصالها، مع الأصل الناقص وموعده. المتأخر بالأحمر: الأصل الأول بعد ${n("3")} أيام، والأصل الثاني بعد ${n("6")} أيام عمل. الضغط على الصيدلية يفتح الطلب.</td></tr>
<tr><td class="k">${ui("Without a receipt")}</td><td>الطلبات التي طلبت المالية لها موافقة دكتور أنور على المشي بدون إيصال، مع السبب: المنتظر منها والمعتمد. الطلب يُرسل من صفحة الطلب نفسه بزر ${ui("Ask the CEO to approve it without a receipt")}.</td></tr>
<tr><td class="k">${ui("The receipt books")}</td><td>الدفاتر الـ${n("16")}، مع من كل دفتر، وعدد إيصالاته المستخدمة والملغاة والمتبقية. الأزرار:<br>
${ui("Hand to")} ومعه اسم المدير، عند تسليم الدفتر لصاحبه المطبوع اسمه · ${ui("Hand out")} لتسليم دفتر احتياطي بعد اختيار المدير · ${ui("Returned to Finance")} عند الاسترداد · ${ui("Record lost")} عند الفقد (مع كتابة ما حدث).</td></tr>
<tr><td class="k">${ui("Cancel a spoiled receipt")}</td><td>إلغاء إيصال تالف برقمه وسبب الإلغاء. الإيصال المستخدم في طلب لا يُلغى.</td></tr>
<tr><td class="k">${ui("Receipts entered and cancelled")}</td><td>سجل الإيصالات: كل إيصال، على أي طلب، ومن أدخله ومتى.</td></tr>
</tbody></table>
${shot("desk-bottom.png", "أسفل نفس الشاشة: الدفتران الاحتياطيان (اختيار المدير ثم Hand out)، وإلغاء إيصال تالف، وسجل الإيصالات.", 98)}
<div class="note keep"><p><b>أول خطوة الآن:</b> عند تسليم كل دفتر لصاحبه، اضغط ${ui("Hand to")} ومعه اسمه، في نفس اليوم. كل الدفاتر مسجّلة الآن على أنها «مع المالية»، ولا يقبل فينيكس أي إيصال من دفتر لم يُسجَّل تسليمه.</p></div>
`);

// ── 2 · The District Managers' working guide ────────────────────────────────────────────────────
const guide = doc("دليل العمل — إيصالات الطلبات المباشرة", `
${mast("دليل العمل — لمديري المناطق")}
<h1>إيصالات الطلبات المباشرة: خطوة بخطوة</h1>
<p class="lead">استلمت دفتر إيصالات باسمك. كل طلب مباشر معتمد تسلّمه لعميل يُثبت بإيصال واحد من دفترك، موقّع ومختوم، ثم يُدخل على فينيكس.</p>
<div class="note keep"><p><b>${OPTIONAL_AR}</b></p></div>

<h2><span class="n">1</span>اعرف إيصالك</h2>
<div class="sample">
  <div class="row"><span class="meta">دفتر رقم ${n("00")} · إيصال ${n("1")} من ${n("50")} · رمز التحقق <span class="code">K7Q2MX</span><span class="tag">رمز التحقق</span></span></div>
  <div class="row" style="margin-top:2mm"><span><b style="color:${C.deep}">رقم الإذن:</b> <span class="serial">000000</span><span class="tag">رقم الإيصال</span></span></div>
  <p class="cap">مثال توضيحي فقط — ليس إيصالاً حقيقياً. <b>رقم الإيصال</b> ستة أرقام أعلى الصفحة، و<b>رمز التحقق</b> ستة حروف وأرقام مطبوع بجوار رقم الدفتر، ويتكرر أسفل الصفحة.</p>
</div>
<table><tbody>
<tr><td class="k">الأصل الأول — إقرار العهدة</td><td>عليه اسمك، وتوقّع فيه أنك استلمت البضاعة أمانة في عهدتك حتى تسلّمها. <b>يبقى في الدفتر</b>، وتُدخل صورته على فينيكس.</td></tr>
<tr><td class="k">الأصل الثاني — استلام العميل</td><td>لا يحمل بياناتك. يوقّعه العميل ويختمه، ثم تنزعه وتُدخل صورته على فينيكس وترسله للمالية — أحمد المراغي.</td></tr>
<tr><td class="k">صورة العميل</td><td>نسخة كربونية من الأصل الثاني، تُنزع وتُسلَّم للعميل.</td></tr>
</tbody></table>

<h2><span class="n">2</span>على الورق — عند كل تسليم</h2>
<ol class="steps">
<li><b class="t">بعد اعتماد الطلب على فينيكس فقط</b>لا تكتب إيصالاً لطلب لم يُعتمد بعد.</li>
<li><b class="t">عند استلام البضاعة من المخزن: املأ الإيصال التالي في دفترك</b>التاريخ، العميل وعنوانه (صيدلية / مخزن / حضانة / مستشفى)، الأصناف بالاسم ورقم التشغيلة والصلاحية والوحدة والكمية والقيمة، وإجمالي الكراتين والقيمة. ما تكتبه هنا ينتقل للأصل الثاني ولصورة العميل.</li>
<li><b class="t">وقّع إقرار العهدة على الأصل الأول</b>اكتب القيمة الإجمالية، واسمك ورقمك القومي، ووقّع. هذا الجزء لا يُنسخ على ورقة العميل.</li>
<li><b class="t">عند التسليم: العميل يوقّع ويختم على الأصل الثاني</b>ارفع الأصل الأول للخلف، فيوقّع العميل ويختم على الأصل الثاني نفسه. بدون توقيع العميل وختمه لا يُحتسب الإيصال.</li>
<li><b class="t">انزع صورة العميل وسلّمها له</b>وانزع الأصل الثاني واحتفظ به حتى تُدخله على فينيكس، ثم أرسله للمالية — أحمد المراغي. الأصل الأول لا يُنزع من الدفتر أبداً.</li>
</ol>

<h2><span class="n">3</span>على فينيكس — الأصل الأول خلال 3 أيام، والأصل الثاني خلال 6 أيام عمل</h2>
<p>المواعيد تبدأ من <b>اليوم التالي لخروج البضاعة من المخزن</b>، كما سجّلته المالية على فينيكس. الجمعة لا تُحسب في الأيام الستة. مثال: خرجت البضاعة الخميس ${n("10")} ديسمبر — الأصل الأول حتى الأحد ${n("13")} ديسمبر، والأصل الثاني حتى الخميس ${n("17")} ديسمبر.</p>
<ol class="steps">
<li><b class="t">افتح الطلب</b>من القائمة ${ui("Direct Orders")}، ثم اضغط على الطلب. ستجد جزءاً بعنوان ${ui("Delivery receipt")}.</li>
<li><b class="t">اكتب رقم الإيصال</b>في خانة ${ui("Receipt number")} — الأرقام الستة كما هي مطبوعة (مثل ${n("000123")}).</li>
<li><b class="t">اكتب رمز التحقق</b>في خانة ${ui("Code beside the number")} — الحروف والأرقام الستة المطبوعة بجوار رقم الدفتر. لا يهم الحرف الكبير أو الصغير.</li>
<li><b class="t">صوّر الأصل الأول الموقّع</b>اضغط ${ui("Photograph Original 1")} للتصوير بالموبايل، أو ${ui("Choose file")} لاختيار صورة أو ملف PDF، ثم ${ui("Save Original 1")}. فينيكس يتحقق في الحال، ويحجز الإيصال للطلب فلا يُستخدم في طلب آخر.</li>
<li><b class="t">بعد التسليم: الأصل الثاني بنفس الرقم والرمز</b>افتح الطلب مرة أخرى، واكتب نفس رقم الإيصال ورمزه، وصوّر الأصل الثاني الموقّع المختوم من العميل بزر ${ui("Photograph Original 2")}، ثم ${ui("Save Original 2")}. تأكد أن الرقم والتوقيع والختم واضحين.</li>
</ol>
<p style="margin-top:3mm"><b>شكل هذا الجزء أسفل صفحة الطلب:</b></p>
<div class="screen">
  <div class="bandx">DELIVERY RECEIPT — TWO ORIGINALS</div>
  <div class="body">
    <div>
      <p>From book 1 (000001–000050). A receipt proves one order only and can never be used again.</p>
      <div class="grid">
        <div><label>Receipt number <i>*</i></label><div class="inp">000123</div><div class="hint">Six digits, at the top of the page</div></div>
        <div><label>Code beside the number <i>*</i></label><div class="inp code">AB3K7Q</div><div class="hint">Six letters and digits</div></div>
      </div>
      <div class="btns"><span class="ghost">Photograph Original 1</span><span class="ghost">Choose file</span></div>
      <div class="accent">Save Original 1</div>
    </div>
  </div>
</div>
<p class="screen-cap" style="text-align:center">رسم توضيحي من خانات الشاشة الحقيقية. يظهر هذا الجزء على طلباتك المعتمدة بعد أن تسجّل المالية تسليم دفترك لك.</p>
<div class="note keep"><p>إذا فات موعد أي أصل — <b>${n("3")} أيام</b> للأصل الأول أو <b>${n("6")} أيام عمل</b> للأصل الثاني — يظهر الطلب متأخراً عند المالية، <b>ولا يقبل فينيكس منك أي طلب جديد</b>، ولا يُعتمد نهائياً أي طلب لك ينتظر الاعتماد، حتى تُدخله.</p></div>

<h2><span class="n">4</span>القواعد</h2>
<ul>
<li><b>${OPTIONAL_AR}</b></li>
<li><b>إيصال واحد لطلب واحد.</b> لا يمكن استخدام نفس الإيصال مرتين، ولا تفيد الصورة الضوئية في شيء.</li>
<li><b>من دفترك أنت فقط.</b> إيصال من دفتر زميل يُرفض، حتى لو كان الطلب في نفس المنطقة.</li>
<li><b>أخطأت في إيصال؟</b> لا تقطعه ولا تكشط فيه. اكتب عليه «ملغى» ووقّع، واتركه في الدفتر بأصليه وصورته، وأبلغ المالية لتلغيه على فينيكس، ثم استخدم الإيصال التالي.</li>
<li><b>فقدت الدفتر؟</b> أبلغ المالية فوراً. تُلغى إيصالاته غير المستخدمة حتى لا يستخدمها أحد.</li>
<li><b>الدفتر عهدة</b> يُرد بكامل أوراقه، المستخدمة وغير المستخدمة، عند الطلب أو عند ترك العمل.</li>
<li><b>البضاعة أمانة في عهدتك.</b> من خروجها من المخزن حتى توقيع العميل وختمه، أنت مسؤول عنها، وعدم تسليمها أو ردها خيانة أمانة كما في إقرار الأصل الأول.</li>
<li><b>أصل متأخر يوقف طلباتك.</b> إذا فات موعد الأصل الأول أو الثاني لا يقبل فينيكس منك أي طلب جديد، لأي صيدلية، حتى تُدخله.</li>
<li><b>صيدلية لم تسدد شيئاً من طلب سابق من نفس الصنف</b> لا تأخذ طلباً ثانياً منه. طلب صنف آخر لها يُرفع عادي.</li>
<li><b>صيدلية سددت جزءاً، أو تأخرت عن ميعاد السداد:</b> الطلب يكمل دورة الموافقات، والاعتماد الأخير لدكتور أنور وحده.</li>
<li><b>لا طلب يمشي بدون إيصال</b> إلا بموافقة دكتور أنور على فينيكس. إذا تعذّر الإيصال لسبب، أبلغ المالية — أحمد المراغي — لتطلب الموافقة مع كتابة السبب.</li>
</ul>

<h2><span class="n">5</span>لو ظهرت رسالة رفض</h2>
<table>
<thead><tr><th style="width:47%">الرسالة على فينيكس</th><th>المعنى وما تفعله</th></tr></thead>
<tbody>
<tr><td>${ui("The code does not match receipt …")}</td><td>رمز التحقق غير صحيح. راجع الحروف الستة بجوار رقم الدفتر واكتبها مرة أخرى.</td></tr>
<tr><td>${ui("There is no receipt … in any Sato Pharma receipt book")}</td><td>رقم الإيصال غير صحيح. راجع الأرقام الستة أعلى الصفحة.</td></tr>
<tr><td>${ui("… was already used on another order")}</td><td>هذا الإيصال استُخدم من قبل. استخدم إيصالاً جديداً، وإن كنت متأكداً أنك لم تستخدمه فأبلغ المالية.</td></tr>
<tr><td>${ui("… is in another manager's book")}</td><td>الإيصال ليس من دفترك. استخدم إيصالاً من دفترك أنت.</td></tr>
<tr><td>${ui("… which Finance has not handed out yet")}</td><td>المالية لم تسجّل تسليم الدفتر لك على فينيكس. تواصل معها.</td></tr>
<tr><td>${ui("… was returned to Finance")}</td><td>الدفتر أُعيد للمالية. تُقبل صفحاته فقط لطلب اعتُمد وهو في عهدتك. تواصل مع المالية.</td></tr>
<tr><td>${ui("… reported lost")}</td><td>الدفتر مسجّل مفقوداً، ولا تُقبل إيصالاته. تواصل مع المالية.</td></tr>
<tr><td>${ui("… while the photo was uploading")}</td><td>تغيّرت حالة الدفتر أثناء رفع الصورة فلم يُحفظ الإيصال. أعد فتح الطلب وتواصل مع المالية.</td></tr>
<tr><td>${ui("… was cancelled")}</td><td>الإيصال ملغى. استخدم الإيصال التالي.</td></tr>
<tr><td>${ui("A receipt is entered once the order is approved")}</td><td>الطلب لم يُعتمد بعد. انتظر الاعتماد.</td></tr>
<tr><td>${ui("This order already has receipt …")}</td><td>الطلب له إيصال بالفعل. لا تكتب له إيصالاً آخر.</td></tr>
<tr><td>${ui("Enter Original 1 … first")}</td><td>أدخل الأصل الأول أولاً، ثم الأصل الثاني على نفس الإيصال.</td></tr>
<tr><td>${ui("Original 2 carries the same number as Original 1")}</td><td>الأصل الثاني من إيصال آخر. اكتب نفس رقم الإيصال الذي أدخلته للأصل الأول.</td></tr>
<tr><td>${ui("Original 2 of receipt … is already entered")}</td><td>الأصل الثاني مُدخل بالفعل. لا تُدخله مرة أخرى.</td></tr>
<tr><td>${ui("… no new order can be raised until then")}</td><td>عندك طلب معتمد فات موعد أحد أصليه، والرسالة تذكر الأكثر تأخراً وأي أصل هو. أدخله أولاً، ثم ارفع الطلب الجديد.</td></tr>
<tr><td>${ui("This pharmacy has not paid anything on its earlier order of …")}</td><td>الصيدلية لم تسدد شيئاً من طلب سابق لنفس الصنف، فلا يُرفع لها طلب ثانٍ منه.</td></tr>
</tbody></table>
<p>ما زالت المشكلة قائمة؟ تواصل مع المالية — أحمد المراغي.</p>
`);

// ── 3 · The printer's instructions ──────────────────────────────────────────────────────────────
const printer = doc("تعليمات طباعة دفاتر الإيصالات — للمطبعة", `
${mast("تعليمات الطباعة — للمطبعة")}
<h1>طباعة دفاتر إيصالات الطلبات المباشرة</h1>
<p class="lead">${n("16")} ملف PDF، ملف لكل دفتر. كل ملف ${n("151")} صفحة: غلاف، ثم ${n("50")} إيصالاً، لكل إيصال ثلاث صفحات متتالية بالترتيب: <b>الأصل الأول</b>، ثم <b>الأصل الثاني</b>، ثم <b>صورة العميل</b>. اسم الملف يحمل رقم الدفتر ومدى أرقامه.</p>

<h2><span class="n">1</span>مواصفات الطباعة</h2>
<table><tbody>
<tr><td class="k">المقاس</td><td>A4 (210 × 297 مم)، <b>بالحجم الفعلي 100%</b>. ممنوع «ملاءمة للصفحة» أو أي تصغير أو تكبير.</td></tr>
<tr><td class="k">الدقة</td><td>${n("600")} نقطة في البوصة أو أعلى.</td></tr>
<tr><td class="k">الصورة</td><td>تُطبع كما هي: بدون تحسين أو تنعيم أو ضغط للصور، وبدون تحويل للرمادي.</td></tr>
<tr><td class="k">الورق</td><td><b>الأصل الأول والأصل الثاني على ورق أمان جاهز ضد النسخ (VOID)</b>، ذاتي النسخ (NCR): الورقة تبدو عادية، وعلى أي صورة ضوئية أو سكانر تظهر كلمة تكشف النسخة. صورة العميل على ورق ذاتي النسخ أبيض عادي.</td></tr>
<tr><td class="k">الألوان</td><td>طباعة ملونة كما في الملف. رقم الإذن أحمر.</td></tr>
</tbody></table>

<h2><span class="n">2</span>التجميع والتجليد</h2>
<ol class="steps">
<li><b class="t">طقم ثلاثي لكل إيصال</b>كل ثلاث صفحات متتالية طقم واحد على ورق ذاتي النسخ (NCR) ثلاثي الطبقات، <b>الأصلان على ورق الأمان ضد النسخ، وصورة العميل على ورق أبيض عادي</b>: الأصل الأول في الأعلى، ثم الأصل الثاني، ثم صورة العميل.</li>
<li><b class="t">الأصل الأول ثابت، والطبقتان الأخريان تُنزعان</b>طبقتا الأصل الثاني وصورة العميل مثقّبتان للنزع. الأصل الأول وحده ثابت في كعب الدفتر.</li>
<li><b class="t">منطقة غير ناقلة (Spot desensitizing)</b>الإطار المنقّط «إقرار العميل» على الأصل الثاني وصورة العميل يقع تحت إقرار العهدة على الأصل الأول تماماً. <b>تُعالَج هذه المنطقة على الطبقتين الثانية والثالثة بحبر مُبطِل للنسخ</b>، فلا ينتقل اسم المدير ورقمه القومي وتوقيعه إلى ورقة العميل. باقي الصفحة ينسخ عادياً.</li>
<li><b class="t">الدفتر</b>الغلاف ثم الأطقم الخمسون بترتيب الملف، بكعب مدبّس أو لاصق لا يُفك. لا تُخلط صفحات دفترين.</li>
</ol>

<h2><span class="n">3</span>قبل طباعة الكمية: اختبار التصوير</h2>
<ol class="steps">
<li><b class="t">اطبع بروفة لطقم إيصال واحد</b>بنفس المواصفات أعلاه. اكتب على إقرار العهدة في الأصل الأول وتأكد أن الكتابة لا تظهر على الأصل الثاني ولا على صورة العميل، وأن كتابة جدول الأصناف تظهر على الثلاثة.</li>
<li><b class="t">صوّرها على ماكينة تصوير</b>على صورة الأصلين يجب أن تظهر كلمة الكشف التي في ورق الأمان (مثل VOID أو COPY) واضحة، ولا تُرى على البروفة نفسها.</li>
<li><b class="t">إن لم تظهر الكلمة على الصورة</b>الورق ليس ورق أمان ضد النسخ، أو طُبع فوق نمطه بحبر كثيف. لا تُطبع الكمية؛ تواصل مع المالية.</li>

</ol>

<h2><span class="n">4</span>السرية</h2>
<ul>
<li>كل صفحة تحمل رقماً ورمز تحقق خاصاً بها. <b>لا تُطبع نسخ زائدة ولا تُحفظ نسخة من الملفات.</b></li>
<li>أي صفحة تالفة أثناء الطباعة تُسلَّم مع الدفاتر، ولا تُرمى.</li>
<li>تُحذف الملفات من أجهزة المطبعة بعد التسليم.</li>
<li>تُسلَّم الدفاتر الـ${n("16")} والصفحات التالفة يداً بيد إلى المالية — أحمد المراغي.</li>
</ul>
`);

// ── 4 · The office copier test (page 1; the sample receipt is appended as page 2) ────────────────
const copier = doc("اختبار ورق الأمان على ماكينة التصوير", `
${mast("اختبار ورق الأمان — قبل طباعة الكمية")}
<h1>اختبار ورق الأمان على ماكينة التصوير</h1>
<p class="lead">الصفحة التالية إيصال عينة، رموزه غير مسجّلة على فينيكس. الاختبار يأخذ دقيقتين، على ورقة من ورق الأمان ضد النسخ الذي ستطبع عليه المطبعة، ويثبت أن أي صورة للأصل تكشف نفسها.</p>
<ol class="steps">
<li><b class="t">خذ ورقة من ورق الأمان من المطبعة</b>واطبع عليها الصفحة التالية وحدها، بالحجم الفعلي 100% (ألغِ «ملاءمة للصفحة»).</li>
<li><b class="t">انظر إلى الورقة المطبوعة</b>تبدو إيصالاً عادياً، بلا كلمة ظاهرة.</li>
<li><b class="t">صوّرها على ماكينة التصوير، واعمل لها سكان</b>على الصورة وعلى السكان تظهر كلمة الكشف (مثل VOID أو COPY).</li>
</ol>
<table>
<thead><tr><th style="width:40%">النتيجة</th><th>المعنى</th></tr></thead>
<tbody>
<tr><td>الكلمة ظاهرة على الصورة والسكان، ولا تُرى على الأصل</td><td><span class="ok">نجح الاختبار</span> — الورق يعمل.</td></tr>
<tr><td>الكلمة لا تظهر على الصورة</td><td>الورق ليس ورق أمان ضد النسخ. اطلب من المطبعة ورقاً غيره قبل طباعة الكمية.</td></tr>
</tbody></table>
<div class="note keep"><p>الذي يمنع استخدام أي نسخة في كل الأحوال هو فينيكس: كل إيصال برقمه ورمزه يُقبل لطلب واحد فقط.</p></div>
`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--disable-extensions"] });
const footer = (label) => `<div style="width:100%;font-family:Tahoma,Arial,sans-serif;font-size:7.4pt;color:${C.muted};padding:0 14mm;direction:rtl;display:flex;justify-content:space-between;"><span>${label}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
async function toPdf(html, file, label, shotBase) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluateHandle("document.fonts.ready");
  await page.pdf({ path: file, format: "A4", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: footer(label) });
  await page.close();
  // previews of every page, read back from the PDF itself
  const pdfPage = await browser.newPage();
  await pdfPage.close();
  console.log("wrote", file, Math.round(fs.statSync(file).size / 1024), "KB");
}
const COPIER_PAGE1 = path.join(OUT, "_copier-test-page1.pdf");
try {
await toPdf(management, path.join(OUT, "دفاتر إيصالات الطلبات المباشرة - ملخص للإدارة.pdf"), "دفاتر إيصالات الطلبات المباشرة — ملخص للإدارة · شركة ساتو فارما");
await toPdf(guide, path.join(OUT, "دليل العمل - إيصالات الطلبات المباشرة - لمديري المناطق.pdf"), "دليل العمل — إيصالات الطلبات المباشرة · شركة ساتو فارما");
await toPdf(printer, path.join(OUT, "تعليمات الطباعة - للمطبعة.pdf"), "تعليمات طباعة دفاتر الإيصالات · شركة ساتو فارما");
await toPdf(copier, path.join(OUT, "_copier-test-page1.pdf"), "اختبار ورق الأمان · شركة ساتو فارما");
} finally {
  await browser.close();
}

// the copier test = its instructions page + the sample's receipt 1 Original (page 2 of the sample book)
const merged = await PDFDocument.create();
for (const [file, pages] of [[COPIER_PAGE1, null], [SAMPLE_PDF, [1]]]) {
  const src = await PDFDocument.load(fs.readFileSync(file));
  for (const pg of await merged.copyPages(src, pages ?? src.getPageIndices())) merged.addPage(pg);
}
const COPIER = path.join(OUT, "اختبار ورق الأمان - ماكينة التصوير.pdf");
fs.writeFileSync(COPIER, await merged.save());
console.log("wrote", COPIER, merged.getPageCount(), "pages");
