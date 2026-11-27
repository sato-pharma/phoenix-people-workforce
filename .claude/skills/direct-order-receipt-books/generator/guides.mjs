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
<tr><td class="k">لمن</td><td>${n("14")} دفتراً مطبوع على كل صفحة منها اسم مدير المنطقة صاحبه، ودفتران احتياطيان (لمدير جديد أو منطقة بلا دفتر).</td></tr>
<tr><td class="k">الإيصال</td><td>أصل وصورتان. يحمل رقماً مسلسلاً، و<b>رمز تحقق</b> من ${n("6")} حروف وأرقام مطبوعاً بجوار الرقم، وكوداً وختماً خاصاً به لا يتكرر.</td></tr>
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
<tr><td>طلب معتمد بلا إيصال</td><td>يظهر عند المالية ويُعلَّم <b>متأخراً بعد ${n("7")} أيام</b> من الاعتماد، ومن ساعتها <b>لا يرفع مديره أي طلب جديد</b>، ولا يُعتمد نهائياً أي طلب له ينتظر الاعتماد، حتى يُدخل الإيصال.</td></tr>
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
<tr><td class="k">علامة مائية مخفية</td><td>عبارة «مُصوَّر — غير صالح» مطبوعة ثلاث مرات في خلفية الصفحة بنقاط دقيقة، لا تُرى على الأصل، <b>وتظهر واضحة على أي صورة ضوئية أو سكانر</b>. الصورة المنسوخة تفضح نفسها.</td></tr>
<tr><td class="k">ختم هندسي لكل إيصال</td><td>زخرفة دائرية يُرسم شكلها من رقم الإيصال ورمزه، فلا يتشابه ختمان في الـ${n("800")} إيصال، وحول الختم الرقم والرمز مكتوبان.</td></tr>
<tr><td class="k">علامة مائية ظاهرة</td><td>نفس الختم مكبّراً وباهتاً خلف جدول الأصناف.</td></tr>
<tr><td class="k">سطر مجهري</td><td>سطر يبدو خطاً رفيعاً، وهو بالعدسة اسم الشركة ورقم الإيصال ورمزه مكرراً. لا يُقرأ في النسخة المصوّرة.</td></tr>
<tr><td class="k">رمز QR</td><td>يحمل رقم الإيصال ورمز التحقق.</td></tr>
<tr><td class="k">اسم صاحب الدفتر</td><td>مطبوع على كل صفحة، مع «الأصل» أو «الصورة الأولى» أو «الصورة الثانية».</td></tr>
</tbody></table></div>
<p>شرط الطباعة: تُطبع الملفات كما هي بدقة ${n("600")} نقطة في البوصة، دون تصغير أو «تحسين» للصورة، ويُجرَّب تصوير صفحة من البروفة على ماكينة تصوير قبل طباعة الكمية للتأكد من ظهور العلامة المخفية.</p>

<h2><span class="n">4</span>من يفعل ماذا</h2>
<table>
<thead><tr><th style="width:26%">الدور</th><th>المسؤولية</th></tr></thead>
<tbody>
<tr><td class="k">مدير المنطقة</td><td>يملأ الإيصال بعد اعتماد الطلب، ويحصل على توقيع العميل وختمه عند التسليم، ثم يُدخل رقم الإيصال ورمزه وصورته على الطلب في فينيكس.</td></tr>
<tr><td class="k">المالية — أحمد المراغي</td><td>تسلّم الدفاتر بإقرار العهدة وتسجّل التسليم على فينيكس، وتستردها، وتسجّل المفقود، وتلغي الإيصال التالف، وتتابع الطلبات المتأخرة، وتطلب من دكتور أنور الموافقة على أي طلب يمشي بدون إيصال. يمكنها أيضاً إدخال الإيصال بدلاً من المدير.</td></tr>
<tr><td class="k">دكتور أنور — الرئيس التنفيذي</td><td>وحده يوافق على طلب يمشي بدون إيصال أو يرفضه، ووحده يعتمد نهائياً طلب صيدلية سددت جزءاً أو تأخرت عن ميعاد السداد.</td></tr>
<tr><td class="k">الإدارة</td><td>تطّلع على السجل كاملاً: كل إيصال، على أي طلب، ومن أدخله ومتى.</td></tr>
</tbody></table>

<h2><span class="n">5</span>دورة العمل باختصار</h2>
<ol class="steps">
<li><b class="t">المالية تسلّم الدفتر</b>يوقّع المدير إقرار العهدة، وتضغط المالية ${ui("Hand to")} ومعه اسم المدير على فينيكس في نفس اليوم. من هذا اليوم تبدأ مطالبة المدير بالإيصالات.</li>
<li><b class="t">الطلب يُعتمد على فينيكس</b>كما هو معمول به الآن، بدون أي تغيير في دورة الموافقات.</li>
<li><b class="t">التسليم للعميل</b>يملأ المدير الإيصال ويوقّعه، ويوقّع العميل ويختم. الصورة الأولى للعميل، والأصل والصورة الثانية يبقيان في الدفتر.</li>
<li><b class="t">الإدخال على فينيكس</b>رقم الإيصال + رمز التحقق + صورة الصفحة الموقّعة المختومة. فينيكس يتحقق في الحال ويقبل أو يرفض.</li>
<li><b class="t">المتابعة</b>أي طلب معتمد بلا إيصال يظهر على شاشة المالية، ويُعلَّم متأخراً بعد ${n("7")} أيام، ولا يرفع مديره طلباً جديداً حتى يُدخله.</li>
</ol>

<div class="note keep">
<p><b>ملاحظات مهمة</b></p>
<ul>
<li>الطلبات التي اعتُمدت <b>قبل</b> استلام المدير لدفتره لا يُطلب لها إيصال.</li>
<li>الإيصال <b>لا يوقف</b> احتساب المبيعات في الشهر ولا تسجيل التحصيل. الذي يوقفه الإيصال المتأخر هو <b>طلبات مديره الجديدة</b>.</li>
<li>لا يحمل دفتراً حالياً: المدير المستقيل، ومدير المبيعات القومي (طلباته نادرة). يُستخدم الاحتياطي عند الحاجة.</li>
</ul>
</div>

<h2><span class="n">6</span>شاشة المالية على فينيكس</h2>
<p>من القائمة: ${ui("Direct Orders")} ← ${ui("Receipt Books")}. تظهر لأحمد المراغي ولمدير النظام فقط.</p>
${shot("desk-top.png", "الشاشة الحقيقية على فينيكس اليوم: الدفاتر كلها «مع المالية» (With Finance)، وبجوار كل دفتر زر التسليم لصاحبه.", 128)}
<table>
<thead><tr><th style="width:34%">الجزء</th><th>الاستخدام</th></tr></thead>
<tbody>
<tr><td class="k">${ui("Approved with no receipt")}</td><td>الطلبات المعتمدة التي لم يُدخل لها إيصال، والمتأخر منها بالأحمر بعد ${n("7")} أيام. الضغط على الصيدلية يفتح الطلب.</td></tr>
<tr><td class="k">${ui("Without a receipt")}</td><td>الطلبات التي طلبت المالية لها موافقة دكتور أنور على المشي بدون إيصال، مع السبب: المنتظر منها والمعتمد. الطلب يُرسل من صفحة الطلب نفسه بزر ${ui("Ask the CEO to approve it without a receipt")}.</td></tr>
<tr><td class="k">${ui("The receipt books")}</td><td>الدفاتر الـ${n("16")}، مع من كل دفتر، وعدد إيصالاته المستخدمة والملغاة والمتبقية. الأزرار:<br>
${ui("Hand to")} ومعه اسم المدير، عند تسليم الدفتر لصاحبه المطبوع اسمه · ${ui("Hand out")} لتسليم دفتر احتياطي بعد اختيار المدير · ${ui("Returned to Finance")} عند الاسترداد · ${ui("Record lost")} عند الفقد (مع كتابة ما حدث).</td></tr>
<tr><td class="k">${ui("Cancel a spoiled receipt")}</td><td>إلغاء إيصال تالف برقمه وسبب الإلغاء. الإيصال المستخدم في طلب لا يُلغى.</td></tr>
<tr><td class="k">${ui("Receipts entered and cancelled")}</td><td>سجل الإيصالات: كل إيصال، على أي طلب، ومن أدخله ومتى.</td></tr>
</tbody></table>
${shot("desk-bottom.png", "أسفل نفس الشاشة: الدفتران الاحتياطيان (اختيار المدير ثم Hand out)، وإلغاء إيصال تالف، وسجل الإيصالات.", 112)}
<div class="note keep"><p><b>أول خطوة الآن:</b> عند تسليم كل دفتر لصاحبه، اضغط ${ui("Hand to")} ومعه اسمه، في نفس اليوم. كل الدفاتر مسجّلة الآن على أنها «مع المالية»، ولا يقبل فينيكس أي إيصال من دفتر لم يُسجَّل تسليمه.</p></div>
`);

// ── 2 · The District Managers' working guide ────────────────────────────────────────────────────
const guide = doc("دليل العمل — إيصالات الطلبات المباشرة", `
${mast("دليل العمل — لمديري المناطق")}
<h1>إيصالات الطلبات المباشرة: خطوة بخطوة</h1>
<p class="lead">استلمت دفتر إيصالات باسمك. كل طلب مباشر معتمد تسلّمه لعميل يُثبت بإيصال واحد من دفترك، موقّع ومختوم، ثم يُدخل على فينيكس.</p>

<h2><span class="n">1</span>اعرف إيصالك</h2>
<div class="sample">
  <div class="row"><span class="meta">دفتر رقم ${n("00")} · إيصال ${n("1")} من ${n("50")} · رمز التحقق <span class="code">K7Q2MX</span><span class="tag">رمز التحقق</span></span></div>
  <div class="row" style="margin-top:2mm"><span><b style="color:${C.deep}">رقم الإذن:</b> <span class="serial">000000</span><span class="tag">رقم الإيصال</span></span></div>
  <p class="cap">مثال توضيحي فقط — ليس إيصالاً حقيقياً. <b>رقم الإيصال</b> ستة أرقام أعلى الصفحة، و<b>رمز التحقق</b> ستة حروف وأرقام مطبوع بجوار رقم الدفتر، ويتكرر أسفل الصفحة.</p>
</div>
<table><tbody>
<tr><td class="k">الأصل</td><td>يبقى في الدفتر.</td></tr>
<tr><td class="k">الصورة الأولى</td><td>تُسلَّم للعميل (جهة التوصيل).</td></tr>
<tr><td class="k">الصورة الثانية</td><td>تبقى في الدفتر.</td></tr>
</tbody></table>

<h2><span class="n">2</span>على الورق — عند كل تسليم</h2>
<ol class="steps">
<li><b class="t">بعد اعتماد الطلب على فينيكس فقط</b>لا تكتب إيصالاً لطلب لم يُعتمد بعد.</li>
<li><b class="t">املأ الإيصال التالي في دفترك بالترتيب</b>التاريخ، جهة التوصيل (العميل / الصيدلية / المخزن / الحضانة / المستشفى)، الأصناف بالاسم ورقم التشغيلة والصلاحية والوحدة والكمية والقيمة، إجمالي الكراتين، ثم وقّع في خانة المستلم (مدير المنطقة).</li>
<li><b class="t">العميل يوقّع ويختم</b>في خانة «توقيع العميل عند التسليم النهائي». بدون توقيع العميل وختمه لا يُحتسب الإيصال.</li>
<li><b class="t">سلّم الصورة الأولى للعميل</b>ولا تنزع الأصل ولا الصورة الثانية من الدفتر.</li>
</ol>

<h2><span class="n">3</span>على فينيكس — خلال 7 أيام من الاعتماد</h2>
<ol class="steps">
<li><b class="t">افتح الطلب</b>من القائمة ${ui("Direct Orders")}، ثم اضغط على الطلب. ستجد جزءاً بعنوان ${ui("Delivery receipt")}.</li>
<li><b class="t">اكتب رقم الإيصال</b>في خانة ${ui("Receipt number")} — الأرقام الستة كما هي مطبوعة (مثل ${n("000123")}).</li>
<li><b class="t">اكتب رمز التحقق</b>في خانة ${ui("Code beside the number")} — الحروف والأرقام الستة المطبوعة بجوار رقم الدفتر. لا يهم الحرف الكبير أو الصغير.</li>
<li><b class="t">صوّر الصفحة الموقّعة والمختومة</b>اضغط ${ui("Photograph the signed page")} للتصوير بالموبايل، أو ${ui("Choose file")} لاختيار صورة أو ملف PDF. تأكد أن الرقم والتوقيع والختم واضحين.</li>
<li><b class="t">اضغط ${ui("Save the receipt")}</b>فينيكس يتحقق في الحال. عند القبول تظهر رسالة أن الإيصال حُفظ مع الطلب ولا يمكن استخدامه في طلب آخر.</li>
</ol>
<p style="margin-top:3mm"><b>شكل هذا الجزء أسفل صفحة الطلب:</b></p>
<div class="screen">
  <div class="bandx">DELIVERY RECEIPT</div>
  <div class="body">
    <div>
      <p>From book 1 (000001–000050). A receipt proves one order only and can never be used again.</p>
      <div class="grid">
        <div><label>Receipt number <i>*</i></label><div class="inp">000123</div><div class="hint">Six digits, at the top of the page</div></div>
        <div><label>Code beside the number <i>*</i></label><div class="inp code">AB3K7Q</div><div class="hint">Six letters and digits</div></div>
      </div>
      <div class="btns"><span class="ghost">Photograph the signed page</span><span class="ghost">Choose file</span></div>
      <div class="accent">Save the receipt</div>
    </div>
  </div>
</div>
<p class="screen-cap" style="text-align:center">رسم توضيحي من خانات الشاشة الحقيقية. يظهر هذا الجزء على طلباتك المعتمدة بعد أن تسجّل المالية تسليم دفترك لك.</p>
<div class="note keep"><p>إذا لم يُدخل الإيصال خلال <b>${n("7")} أيام</b> من اعتماد الطلب، يظهر الطلب متأخراً عند المالية، <b>ولا يقبل فينيكس منك أي طلب جديد</b>، ولا يُعتمد نهائياً أي طلب لك ينتظر الاعتماد، حتى تُدخله.</p></div>

<h2><span class="n">4</span>القواعد</h2>
<ul>
<li><b>إيصال واحد لطلب واحد.</b> لا يمكن استخدام نفس الإيصال مرتين، ولا تفيد الصورة الضوئية في شيء.</li>
<li><b>من دفترك أنت فقط.</b> إيصال من دفتر زميل يُرفض، حتى لو كان الطلب في نفس المنطقة.</li>
<li><b>أخطأت في إيصال؟</b> لا تقطعه ولا تكشط فيه. اكتب عليه «ملغى» ووقّع، واتركه في الدفتر بأصله وصورتيه، وأبلغ المالية لتلغيه على فينيكس، ثم استخدم الإيصال التالي.</li>
<li><b>فقدت الدفتر؟</b> أبلغ المالية فوراً. تُلغى إيصالاته غير المستخدمة حتى لا يستخدمها أحد.</li>
<li><b>الدفتر عهدة</b> يُرد بكامل أوراقه، المستخدمة وغير المستخدمة، عند الطلب أو عند ترك العمل.</li>
<li><b>إيصال متأخر يوقف طلباتك.</b> بعد ${n("7")} أيام بلا إيصال لا يقبل فينيكس منك أي طلب جديد، لأي صيدلية، حتى تُدخله.</li>
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
<tr><td>${ui("… no new order can be raised until then")}</td><td>عندك طلب معتمد مر عليه أكثر من ${n("7")} أيام بلا إيصال، والرسالة تذكر أقدمه. أدخل إيصاله أولاً، ثم ارفع الطلب الجديد.</td></tr>
<tr><td>${ui("This pharmacy has not paid anything on its earlier order of …")}</td><td>الصيدلية لم تسدد شيئاً من طلب سابق لنفس الصنف، فلا يُرفع لها طلب ثانٍ منه.</td></tr>
</tbody></table>
<p>ما زالت المشكلة قائمة؟ تواصل مع المالية — أحمد المراغي.</p>
`);

// ── 3 · The printer's instructions ──────────────────────────────────────────────────────────────
const printer = doc("تعليمات طباعة دفاتر الإيصالات — للمطبعة", `
${mast("تعليمات الطباعة — للمطبعة")}
<h1>طباعة دفاتر إيصالات الطلبات المباشرة</h1>
<p class="lead">${n("16")} ملف PDF، ملف لكل دفتر. كل ملف ${n("151")} صفحة: غلاف، ثم ${n("50")} إيصالاً، لكل إيصال ثلاث صفحات متتالية بالترتيب: <b>الأصل</b>، ثم <b>الصورة الأولى</b>، ثم <b>الصورة الثانية</b>. اسم الملف يحمل رقم الدفتر ومدى أرقامه.</p>

<h2><span class="n">1</span>مواصفات الطباعة</h2>
<table><tbody>
<tr><td class="k">المقاس</td><td>A4 (210 × 297 مم)، <b>بالحجم الفعلي 100%</b>. ممنوع «ملاءمة للصفحة» أو أي تصغير أو تكبير.</td></tr>
<tr><td class="k">الدقة</td><td>${n("600")} نقطة في البوصة أو أعلى.</td></tr>
<tr><td class="k">الصورة</td><td>تُطبع كما هي: بدون تحسين أو تنعيم أو ضغط للصور، وبدون تحويل للرمادي. خلفية الصفحة فيها نقاط دقيقة جداً هي علامة الحماية؛ أي تنعيم يضيعها.</td></tr>
<tr><td class="k">الألوان</td><td>طباعة ملونة كما في الملف.</td></tr>
</tbody></table>

<h2><span class="n">2</span>التجميع والتجليد</h2>
<ol class="steps">
<li><b class="t">طقم ثلاثي لكل إيصال</b>كل ثلاث صفحات متتالية طقم واحد على ورق ذاتي النسخ (NCR) ثلاثي الطبقات، <b>كل الطبقات بيضاء</b>: الأصل في الأعلى، ثم الصورة الأولى، ثم الصورة الثانية.</li>
<li><b class="t">الصورة الأولى وحدها تُنزع</b>طبقة الصورة الأولى مثقّبة للنزع. الأصل والصورة الثانية ثابتان في كعب الدفتر.</li>
<li><b class="t">الدفتر</b>الغلاف ثم الأطقم الخمسون بترتيب الملف، بكعب مدبّس أو لاصق لا يُفك. لا تُخلط صفحات دفترين.</li>
</ol>

<h2><span class="n">3</span>قبل طباعة الكمية: اختبار التصوير</h2>
<ol class="steps">
<li><b class="t">اطبع بروفة لصفحة إيصال واحدة</b>بنفس المواصفات أعلاه.</li>
<li><b class="t">صوّرها على ماكينة تصوير عادية</b>يجب أن تظهر عبارة «مُصوَّر — غير صالح» واضحة على الصورة، ولا تظهر على البروفة نفسها.</li>
<li><b class="t">إن ظهرت العبارة على البروفة</b>الطباعة أغمق من اللازم: خفّف كثافة الحبر وأعد البروفة.</li>
<li><b class="t">إن لم تظهر على الصورة</b>صوّر مرة أخرى على وضع «نص» في الماكينة. إن لم تظهر أيضاً، أوقف الطباعة وتواصل مع المالية.</li>
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
const copier = doc("اختبار العلامة المخفية على ماكينة التصوير", `
${mast("اختبار العلامة المخفية — قبل الذهاب للمطبعة")}
<h1>اختبار العلامة المخفية على ماكينة التصوير</h1>
<p class="lead">الصفحة التالية إيصال عينة، رموزه غير مسجّلة على فينيكس. الاختبار يأخذ دقيقتين على طابعة وماكينة تصوير المكتب، ويثبت أن عبارة «مُصوَّر — غير صالح» تظهر على أي نسخة مصوّرة.</p>
<ol class="steps">
<li><b class="t">اطبع الصفحة التالية وحدها</b>على طابعة ليزر، بالحجم الفعلي 100% (ألغِ «ملاءمة للصفحة») وبأعلى جودة.</li>
<li><b class="t">انظر إلى الورقة المطبوعة</b>الخلفية ظل أزرق باهت متساوٍ. العبارة لا تُرى، أو تُرى بالكاد إذا دققت.</li>
<li><b class="t">صوّر الورقة على ماكينة التصوير</b>على الصورة يجب أن تظهر «مُصوَّر — غير صالح» ثلاث مرات بشكل مائل وواضح.</li>
</ol>
<table>
<thead><tr><th style="width:40%">النتيجة</th><th>المعنى</th></tr></thead>
<tbody>
<tr><td>العبارة ظاهرة على الصورة فقط</td><td><span class="ok">نجح الاختبار</span> — العلامة تعمل.</td></tr>
<tr><td>العبارة ظاهرة على الورقة المطبوعة نفسها</td><td>الطابعة طبعت أغمق من اللازم أو صغّرت الصفحة. أعد الطباعة بالحجم الفعلي.</td></tr>
<tr><td>العبارة لا تظهر على الصورة</td><td>صوّر مرة أخرى على وضع «نص». إن لم تظهر، أرسل صورة للنسخة لمراجعة العلامة قبل المطبعة.</td></tr>
</tbody></table>
<div class="note keep"><p>على شاشة الكمبيوتر قد تظهر العبارة عند تصغير الصفحة؛ هذا طبيعي، فالشاشة تتصرف مثل ماكينة التصوير. الحكم على الورق فقط.</p></div>
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
await toPdf(copier, path.join(OUT, "_copier-test-page1.pdf"), "اختبار العلامة المخفية · شركة ساتو فارما");
} finally {
  await browser.close();
}

// the copier test = its instructions page + the sample's receipt 1 Original (page 2 of the sample book)
const merged = await PDFDocument.create();
for (const [file, pages] of [[COPIER_PAGE1, null], [SAMPLE_PDF, [1]]]) {
  const src = await PDFDocument.load(fs.readFileSync(file));
  for (const pg of await merged.copyPages(src, pages ?? src.getPageIndices())) merged.addPage(pg);
}
const COPIER = path.join(OUT, "اختبار العلامة المخفية - ماكينة التصوير.pdf");
fs.writeFileSync(COPIER, await merged.save());
console.log("wrote", COPIER, merged.getPageCount(), "pages");
