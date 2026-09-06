import assert from "node:assert/strict";

import { isStoreCustomer } from "../src/lib/sales/customer-channel.ts";

/**
 * THE OWNER'S OWN RULINGS, ONE ROW PER CUSTOMER — the ground truth the warehouse rule is built on.
 *
 * On 2026-09-06 he was sent `xlsx/sos-warehouse-keyword-decisions-2026-09-06.xlsx` — 167
 * customers the six STORE_NAME_KEYWORDS do not catch, each row carrying the sales value, the areas
 * it sells in, and a locked dropdown. He answered every one: 73 warehouse, 78 pharmacy,
 * 16 government depot. Four he had answered two different ways were put back to him and settled
 * the same day (دار الفتح, ايةام جروب, الزهراء, اسلام حسن — all warehouses).
 *
 * WHY THE WHOLE LIST IS PINNED AND NOT A SAMPLE. This is a NAME rule: it reads text a distributor
 * typed. Widening a stem by one letter, adding a word, or changing the Arabic folding silently
 * re-decides customers nobody was looking at, and the only symptom is money moving between areas in
 * a published closing — which the publication drift check cannot see, because it compares UNITS and
 * the split preserves each line's unit total while moving units between areas. So every answer he
 * gave is an assertion here. A change that re-decides one of them turns this test red and has to go
 * back to him.
 *
 * Both halves of the rule are covered, deliberately: the trade phrase finds most of these on its
 * own, and the rest are named in STORE_OVERRIDE_NAMES / PHARMACY_OVERRIDE_NAMES /
 * PHARMACY_OVERRIDE_CHAINS. This test does not care which route a customer takes, only that the
 * answer is the one he gave — so moving a customer between those lists is free, and changing the
 * verdict is not.
 *
 * A duplicate (name, code, distributor) is dropped. The same customer at two distributors is KEPT:
 * that is two accounts, and he answered each one.
 */
const OWNER_RULINGS: ReadonlyArray<
  readonly [string, string, string, "warehouse" | "pharmacy" | "government"]
> = [
  ["المستودع الطبى الرئيسى الجبل ا","0003000003","PS","government"],
  ["الفرسان انترناشيونال جروب","0001558912","PS","warehouse"],
  ["طاى جروب","433363","IS","pharmacy"],
  ["اى بى يو لتجارة و توزيع الادوية","429955","IS","pharmacy"],
  ["شركة طاى جروب","3080282","RM","pharmacy"],
  ["ت.ص.مخازن السيوف","0003000591","PS","pharmacy"],
  ["ت.ص.مخازن السيوف","3000591","PS-T","government"],
  ["شركه أيه ام جروب","0001535504","PS","pharmacy"],
  ["يونس لتجارة وتوزيع اﻻدوية","0001546881","PS","warehouse"],
  ["فرع البحيرة - المخازن العامة بدمنهور- قوى عاملة","89970","EG-HOS","government"],
  ["ت.ص.مخازن الرئيسية دمنهور","0003000183","PS","government"],
  ["ت.ص.مخازن الرئيسية دمنهور","3000183","PS-T","government"],
  ["دار الفتح لتجارة وتوزيع الادوية","448667","IS","warehouse"],
  ["الهيئه العربيه للتصنيع – المخازن المركزية المعادى","1219","RM-T","government"],
  ["الفرسان انترناشيونال جروب","416032","IS","warehouse"],
  ["الاوائل لتجارةالادوية","336554","IS","warehouse"],
  ["اى سى اس لتجارة وتوزيع الادوية","449717","IS","warehouse"],
  ["الفتح لتجارة وتوزيع الادية","0001556090","PS","warehouse"],
  ["الفرسان انترناشيونال جروب","441524","IS","warehouse"],
  ["اى بى يو لتجارة و توزيع الادوية","429955","IS-S","pharmacy"],
  ["يونس لتجارةوتوزيع الادوية","440901","IS-S","warehouse"],
  ["شركة الراية لتجارة الادوية","0001527702","PS","warehouse"],
  ["ابو عميرة  ن.م لتوريد و توزيع","0001560498","PS","warehouse"],
  ["طيبة جروب","436113","IS","warehouse"],
  ["الدولية لتجارة الادوية","402301","IS","warehouse"],
  ["تارجت لتجارة وتوزيع الادوية","427646","IS","warehouse"],
  ["مصطفى نبيل الطرشوبى لتجارةاﻻدوية","436381","IS","pharmacy"],
  ["الرؤى والنور لتجارةالادوية","420140","IS","warehouse"],
  ["تيسلا لتجارة وتوزيع الادوية","447638","IS","warehouse"],
  ["فرع القاهرة - المنطقة الاولى - مخازن شبرا","139097","EG-HOS","government"],
  ["ت.ص.مخازن جرجا","0003000195","PS","government"],
  ["ت.ص.مخازن جرجا","3000195","PS-T","government"],
  ["الهيئة العربية للتصنيع المخازن الرئيسية","1204","RM-T","government"],
  ["ايةام جروب للاستثمار وتجارةالادوية","428612","IS-S","warehouse"],
  ["شركة اورينت جروب - بهتيم","164162","EP-BK","pharmacy"],
  ["شركة ابوعميره لتوريد وتوزيع الادوية","449087","IS","warehouse"],
  ["غرناطة لتجارة وتوزيع الادوية","406681","IS","warehouse"],
  ["الزهراء لتجارةوتوزيع اﻻدويةومستلزمات","434650","IS","warehouse"],
  ["شركة المحمدية لتجارة وتوزيع ال","0001534401","PS","warehouse"],
  ["تيسلا لتجارة الدواء","0001554353","PS","warehouse"],
  ["طاى جروب","433363","IS-S","pharmacy"],
  ["الدوائية لتجارة وتوزيع الادوية","447891","IS","warehouse"],
  ["مصطفى نبيل الطرشوبى لتجاره الادويه بالجمله","8010355","RM","pharmacy"],
  ["الحكمةلتجارةوتوزيع اﻻدويةوالمستلزما","437285","IS","warehouse"],
  ["كيان ايجيبت لتجارة وتوزيع الادوية","446514","IS","warehouse"],
  ["اسلام حسن لتجارة الادويه - مدينة نصر","163891","EP-BK","warehouse"],
  ["مى البراوى لتجارة وتوزيع الادويه","464022","IS","warehouse"],
  ["شركة الماسةلتجارة وتوزيع الادوية","444743","IS","warehouse"],
  ["تيسلا لتجارة وتوزيع الادوية","447638","IS-S","warehouse"],
  ["الصفا ميديكال لتجارة وتوزيع الا دوية","407155","IS","warehouse"],
  ["تارجت لتجارة وتوزيع الادوية","427646","IS-S","warehouse"],
  ["الاقصر الدولية لتجارة الادوية","431158","IS","warehouse"],
  ["اسلام حسن لتجارة وتوزيع الادوية","448232","IS","warehouse"],
  ["يونس لتجارةوتوزيع الادوية","440901","IS","warehouse"],
  ["وائل عبدالستار ابراهيم //مطلوب سجل تجارى \\محظور سموم بقرار رقم 172","36596","EG","pharmacy"],
  ["فرع القاهرة - المنطقة الرابعة - مخازن شبرا","82374","EG-HOS","government"],
  ["شركة محمد حسنى وشريكة لتجارة الادوية","164187","EP-PHS","warehouse"],
  ["سيناء لتجارة وتوزيع الادويه - المعادى","163868","EP-PHS","warehouse"],
  ["كيان ايجيبت لتجارة وتوزيع الادوية","446514","IS-S","warehouse"],
  ["ماتريكس لتجارة و توزيع الادوية","0001573036","PS","warehouse"],
  ["فرع شمال غرب الدلتا - المخازن العامة السيوف (ق ع)","135429","EG-HOS","government"],
  ["المعداوى لتجارةوتوزيع الادوية","417052","IS-S","warehouse"],
  ["الرؤى والنور لتجارةالادوية","420140","IS-S","warehouse"],
  ["الشفاء لتجارة و توزيع الادوية","0001566693","PS","warehouse"],
  ["الشفاء لتجارة وتوزيع الادوية","419908","IS-S","warehouse"],
  ["الزهراء لتجارة الادوية","0001533808","PS","warehouse"],
  ["المعداوى لتجارةوتوزيع الادوية","417052","IS","warehouse"],
  ["الاهرام لتجارةاﻻدويةومستلزمات الطبية","432804","IS","warehouse"],
  ["هناء ( ادارة برسوم جروب )","1500011974","SF","pharmacy"],
  ["ال ياسين لتجارة وتوزيع الادوية","441162","IS-S","warehouse"],
  ["سيف الاسلام لتجارة وتوزيع الادوية","426630","IS","warehouse"],
  ["ال ياسين لتجارة وتوزيع الادوية","441162","IS","warehouse"],
  ["الجمهورية لتجارة وتوزيع ن م","0001541015","PS","warehouse"],
  ["شركة طاى جروب","1500023301","SF","pharmacy"],
  ["الوجيه لتجارة الادويه - المنوفيه","164155","EP-PHS","warehouse"],
  ["ابوالوفاء -دمياط (ورثه)/  مطلوب سجل تجارى حديث","879","EG","pharmacy"],
  ["ايةام جروب للاستثمار وتجارةالادوية","428612","IS","warehouse"],
  ["صيدلية القناة لتوزيع الكهرباء - الزقازيق","60237","EG-BR","pharmacy"],
  ["اى سى اس لتجارة وتوزيع الادوية","449717","IS-S","warehouse"],
  ["الهادى لتجارةوتوزيع الادوية","437875","IS","warehouse"],
  ["كايرو كابيتال لتجارة الادوية","442176","IS","warehouse"],
  ["شركة محمد عابدين محمد لتجارة الادوية","429850","IS","pharmacy"],
  ["الحكمة - اشمون / نقدي شباك بدون سجل تجاري /مطلوب اوراق تحديث","5091","EG","pharmacy"],
  ["الفاتح لتجارة وتوزيع الادويه","1500017188","SF","pharmacy"],
  ["دار الفتح لتجارة وتوزيع الادوية - كفر الشيخ","164177","EP-PHS","warehouse"],
  ["المستودع الطبى الرئيسى الجبل الاحمر","3000003","PS-T","government"],
  ["ت.ص.مخازن الهيئة بطهطا","3000529","PS-T","government"],
  ["ابراهيم محمد -كليوباترا جروب","0001546824","PS","pharmacy"],
  ["الدولية لتجارة الادوية","427070","IS","warehouse"],
  ["مصر ميديكال لتجارة الادوية","164036","EP-BK","warehouse"],
  ["ت.ص.مخازن الهيئة بطهطا","0003000529","PS","government"],
  ["الحرية لتجارة وتوزيع الادوية","429112","IS","warehouse"],
  ["لصحى الاسكندريه -المخازن العامه - ا","6500000737","SF-T","government"],
  ["خالد حسين زكى//مطلوب سجل تجارى سارى","139514","EG","pharmacy"],
  ["النهضه  لتجاره وتوزيع الادويه","0001557198","PS","warehouse"],
  ["الدوائية لتجارة وتوزيع الادوية","447891","IS-S","warehouse"],
  ["احمد ماضي -كفر سعد / مطلوب سجل تجارى","32859","EG","pharmacy"],
  ["فيلومينا لتجارة وتوزيع الادوية","434677","IS","warehouse"],
  ["شركة البركة لتجارة وتوزيع الادوية","416371","IS-S","warehouse"],
  ["العوضي / الزرقا ( مطلوب سجل تجارى سارى )- ايقاف ض ح","1111","EG","pharmacy"],
  ["احمد محمودبورعبده النجار  ( مطلوب سجل تجارى حديث )","18253","EG","pharmacy"],
  ["الخليجية لتجارة وتوزيع الادوية","440462","IS","warehouse"],
  ["مكة لتجارة وتوزيع الادوية","403184","IS","warehouse"],
  ["الدولية لتجارةالادوية","0001533304","PS","warehouse"],
  ["امنيه - زنين بولاق /  نقدى شباك لحين احضارسجل تجارى حديث )","56137","EG","pharmacy"],
  ["طيبة لتجارة وتوزيع الادوية","443300","IS","warehouse"],
  ["احمد لطفى محمد - البرانية /نقدي - مطلوب سجل تجاري كامل","76562","EG","pharmacy"],
  ["عز الرجال / شمال سيناء/ مطلوب سجل تجارى سارى","54319","EG","pharmacy"],
  ["احمد نبوى - 6أكتوبر / مطلوب سجل تجارى سارى","33288","EG","pharmacy"],
  ["محمد لطفي - السويس /مطلوب سجل تجاري ساري","19836","EG","pharmacy"],
  ["شادى محمد عبد البديع / مطلوب سجل تجارى سارى","1853","EG","pharmacy"],
  ["الشفاء لتجارة وتوزيع الادوية","419908","IS","warehouse"],
  ["شركة محمد عابدين محمد لتجارة الادوية","429850","IS-S","pharmacy"],
  ["محمد حربي / المقطم / مطلوب سجل تجارى وبطاقة شخصية سارية","74176","EG","pharmacy"],
  ["المنياوى الحديثة-الزاوية*تعجيل دفع*/  مطلوب سجل تجارى","43600","EG","pharmacy"],
  ["الزهراء لتجارةوتوزيع الادويةجملة","445636","IS","warehouse"],
  ["الفيروز / مطلوب سجل تجارى سارى","59709","EG","pharmacy"],
  ["محمد سرحان - المقطم / مطلوب بطاقة شخصية وسجل تجارى ساريين","35638","EG","pharmacy"],
  ["شريف شحاتة - المنصورة //مطلوب سجل تجارى ساري","76838","EG","pharmacy"],
  ["شريف كمال  - السويس//مطلوب سجل تجارى سارى","8192","EG","pharmacy"],
  ["احمد صبرى عبدالفتاح - محرم بك (سجل تجاري حديث","114168","EG","pharmacy"],
  ["شركة اورينت جروب - بهتيم","164162","EP-PHS","pharmacy"],
  ["الاسعاف - الجسر//مطلوب سجل تجارى سارى","42603","EG","pharmacy"],
  ["احمد على - نقدى شباك  بدون سموم - بهجورة( مطلوب بطاقه شخصيه وسجل تجارى","10682","EG","pharmacy"],
  ["بسمة صلاح - السويس//مطلوب سجل تجارى سارى","21402","EG","pharmacy"],
  ["نجلاء ربيع - محروس جروب","0001583017","PS","pharmacy"],
  ["ثروت - شارع الترعة / ( منقول من فرع اغاخان ) / مطلوب سجل تجارى سارى","44102","EG","pharmacy"],
  ["سعد الهوارى / الوراق //مطلوب سجل تجارى سارى","53822","EG","pharmacy"],
  ["معتزة رخا الجديدة / الاعصر / دمياط / مطلوب سجل تجارى سارى","139976","EG","pharmacy"],
  ["السلام الجديدة بهتيم - شبرا الخيمة / مطلوب سجل تجارى","38792","EG","pharmacy"],
  ["دينا اشرف / ملوى / المنيا / مطلوب رقم التليفون / نقدى سيارة ( لعدم وجود سجل تجارى او بيان حالة وظيفية )","143578","EG","pharmacy"],
  ["محمد النمر حمدان احمد / فرشوط ( مطلوب سجل تجارى ) نقدى شباك","140178","EG","pharmacy"],
  ["احمد محمد السيد عوض الطحان/بورسعيد/سجل تجارى حديث","123907","EG","pharmacy"],
  ["عماد حماده عبد الفهيم الجديدة(مطلوب سجل تجارى سارى)","123046","EG","pharmacy"],
  ["محمد سامى -الشعراء//مطلوب سجل تجارى سارى","1187","EG","pharmacy"],
  ["اسلام حسن لتجارة الادويه - مدينة نصر","163891","EP-PHS","warehouse"],
  ["العبير / طهطا / سوهاج / بدون سموم / نقدى شباك ( لعدم وجود سجل تجارى )","76648","EG","pharmacy"],
  ["بيشوي يوسف / العجوزة//مطلوب سجل تجارى سارى","72190","EG","pharmacy"],
  ["احمد حمدي محمد الجديدة (مطلوب سجل تجارى سارى)","73826","EG","pharmacy"],
  ["نورهان مبارك - حدائق الاهرام ( مطلوب سجل تجارى حديث )","34592","EG","pharmacy"],
  ["محمد العطار- مساكن المحمودية مطلوب سجل تجاري","75723","EG","pharmacy"],
  ["محمد صلاح الدين الجديدة - ابوتشت / مطلوب سجل تجارى حديث / نقدى شباك","75791","EG","pharmacy"],
  ["يوسف يعقوب -السويس//مطلوب سجل تجارى سارى","16747","EG","pharmacy"],
  ["اللواء -دمياط / مطلوب سجل تجارى","83744","EG","pharmacy"],
  ["الهاشم لتجارة و توزيع الادوية","454920","IS","pharmacy"],
  ["اسماء احمد عبدالعزيز / دير مواس / المنيا / مطلوب الورقة رقم (2)للسجل التجارى","143487","EG","pharmacy"],
  ["احمد عبد الحميد على متولى الجديدة -بنها //مطلوب سجل تجارى سارى","139713","EG","pharmacy"],
  ["ايهاب_فيصل.--RG / مطلوب سجل تجارى سارى","56223","EG","pharmacy"],
  ["محمد  سناري  -السويس//مطلوب سجل تجارى سارى","38213","EG","pharmacy"],
  ["ميشيل جان ( ادارة برسوم جروب )","1500012711","SF","pharmacy"],
  ["انطون دولف / المراغه / بدون سموم / مطلوب رقم التليفون / نقدى شباك ( مطلوب سجل تجارى او بيان حالة )","144070","EG","pharmacy"],
  ["ناصر ابراهيم -السويس//مطلوب سجل تجارى سارى","50611","EG","pharmacy"],
  ["شيماء زكي عبدالرحمن الجديده  - ابو زعبل / مطلوب سجل تجارى سارى","28607","EG","pharmacy"],
  ["احمد اسامة ناصر //مطلوب سجل تجارى سارى","55315","EG","pharmacy"],
  ["مصطفى خضر - مجموعة ام اتش لاداره الصيدليات و تجاره الادويه","3200164","RM","pharmacy"],
  ["دسبينا-مجموعة ام اتش لاداره الصيدليات و تجاره الادويه","3330170","RM","pharmacy"],
  ["الحرمين  - باب الشعريه  مطلوب بطاقه شخصيخ + سجل تجارى كامل","42867","EG","pharmacy"],
  ["سوزانا / النزهه  ( سجل تجارى حديث )","39870","EG","pharmacy"],
  ["سامى / نقدي لحين ارسال السجل التجاري/ بدون سموم","108096","EG","pharmacy"],
  ["ميلاد بشرى / بدون سموم / سمالوط / المنيا / مطلوب الورقة رقم (3) للسجل التجارى","3821","EG","pharmacy"],
  ["حاتم الجديدة / فاو بحرى / دشنا / مطلوب سجل تجارى حديث / نقدى شباك","5762","EG","pharmacy"],
  ["فاطمه فرغلي سيد / الشرقي سمهود / نقدى شباك / مطلوب سجل تجارى حديث","8970","EG","pharmacy"],
  ["المستقبل لتجارة الادوية - السلام قطاعى","164305","EP-PHS","warehouse"],
  ["رما لتجارة وتوزيع الادوية (صحة اهل","1500048108","SF","warehouse"],
  ["المملكة لتجارة وتوزيع الادوية","447909","IS","warehouse"],
  ["شركة الحمد لتوزيع الادويةوالمستلزمات","343292","IS","warehouse"],
  ["عامر - العجوزة //مطلوب سجل تجارة ساري","54066","EG","pharmacy"],
];

export function runSosWarehouseOwnerRulingsTests() {
  assert.equal(OWNER_RULINGS.length, 167, "every customer he ruled on is pinned here");
  assert.equal(
    OWNER_RULINGS.filter((row) => row[3] === "warehouse").length,
    73,
    "the count he marked warehouse, unchanged since 2026-09-06",
  );

  const wrong: string[] = [];
  for (const [name, clientCode, distributorCode, verdict] of OWNER_RULINGS) {
    const expected = verdict === "warehouse";
    if (isStoreCustomer(name, clientCode, distributorCode) !== expected) {
      const want = expected ? "should SPLIT" : "should NOT split";
      wrong.push(`${want} — ${name} [${distributorCode} ${clientCode}] ruled ${verdict}`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `${wrong.length} customer(s) no longer match the owner's 2026-09-06 rulings:\n  ${wrong.join("\n  ")}`,
  );

  // A government depot must be refused by a NEVER_STORE word, not merely fall through for want of a
  // store word — otherwise adding any future keyword its name happens to contain would start
  // splitting a health-insurance or army depot with nothing to catch it.
  for (const [name, clientCode, distributorCode, verdict] of OWNER_RULINGS) {
    if (verdict !== "government") continue;
    assert.equal(
      isStoreCustomer(name, clientCode, distributorCode),
      false,
      `government depot must never split: ${name}`,
    );
  }
}
