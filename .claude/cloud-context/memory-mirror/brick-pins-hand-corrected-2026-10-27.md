---
name: brick-pins-hand-corrected-2026-10-27
description: "69 brick-centroid pins were hand-corrected on the owner's word on 2026-10-27 (map 561 → 602 of 626 drawn); how they were found, which were left alone and why, and what would undo them"
metadata:
  node_type: memory
  type: project
  originSessionId: 7e3f9218-9af1-45ab-823d-b2466e264784
  modified: 2026-10-27T18:24:43.358Z
---

On 2026-10-27 (owner's word, two multiple-choice answers) 24 `geo_locations` rows with `source_type='brick_centroid'` were moved in production:
- 5 at 20:26 Cairo onto Google geocodes of a named place (Heliopolis ش عثمان بن عفان / المحكمة / ش صلاح الدين, الهرم, الاخصاص).
- 19 at 20:35 Cairo onto the median of the brick's own pharmacy-address geocodes; their `address_text` says "re-pinned 27 Oct 2026".
- All are `geocode_provider='google_geocode'`, `geocode_status='success'`; `city` was left as it was. Old rows were backed up to session scratchpad JSON only (no history table).

**25 more at 20:54 Cairo (owner: "Fix the 25 with evidence"), Anti Infective map audit — 561 → 581 of 626 drawn:**
- 12 `shared_fallback` → `success`, coordinates unchanged (pins 0–2.6 km from their pharmacies; guarded: no other live success pin on the point): منقباد, عرب الجسر, كوم النور, اطفيح, كفر حكيم, صفط الخمار, القناويه, بلصفورة, دهشور, عثمان محرم, ش رمسيس, مدينة سوهاج.
- 7 twin partners `success` → `shared_fallback` so the right brick on that point draws: العصافرة بحرى, المرج الجديده, دنطيط, شارع مصطفى فهمى, السراو, المنشاة, سنورس (Damietta). Each still needs its OWN pin — follow-up chip task_02c47e6d.
- 6 moved to the pharmacy median: سنورس - فيوم, القاهرة الجديدة, مرسى مطروح (brick spans the whole Matrouh coast; 15 of 32 within 25 km), الرحمانيه (was rep check-in GPS, 17 km off), طره البلد, ش الجزائر (both were near Dokki).
- The map's predecessor rule prefers a success pin (service.ts ~897), so مدينة قنا (Qena 2) draws via B209B-1 though B209-1's pin is hidden — a naive SQL join counts 627.

**20 more at 21:22 Cairo (owner picked "20 strong pins" in a multiple-choice question), the 45 still hidden on all three lines — now Anti Infective 602/626, CNS 610/631, Pedia 602/626 drawn; 24 hidden, the same 24 on every line:**
- Each moved to the median of its own pharmacy addresses that NAME the place (densest 4 km cluster; Egypt-centre and ≥8-shared points dropped; addresses read). `address_text` = "Centre of this brick's pharmacy addresses (N of M agree), re-pinned 27 Oct 2026"; English `area`; `city` untouched. One guarded DO block (exact row counts, and no new pin on an exact point shared with another live success pin).
- القلج 24/26 · العصافرة بحرى 12/15 · اولاد عمرو 11/11 · بنى احمد الشرقية 9/9 · الدير 8/10 · البرجايه 8/10 · سرياقوس 8/8 · القرشية 8/9 · كوتسيكا 6/13 (the other 7 are same-named streets elsewhere in Cairo) · الطوابيه 5/6 · الجبل الاصفر 5/6 · سفير 4/6 · امتداد رمسيس 4/5 · احمد تيسير 3/3 · المرج الجديده 3/4 · شرنقاش 3/3 · مصطفى فهمى 2/2 · سانديون 2/2 · محله إنشكاك 2/2 · أرض غنيم 2/2.
- القلج, الجبل الاصفر and سرياقوس shared one El Marg point, so القلج HAD to move with them (it was "mixed village" below). شها (B208-15, no pharmacies) set success → `shared_fallback` so it does not draw alone on سانديون's old Qalyubia-centre point; that unhid بنى احمد الغربية on its own pin (16/16).
- Backup of the 21 old rows: `backup-brick-pins-2026-10-27T18-22-33-715Z.json` in session 87b7ed99's scratchpad (`%TEMP%\claude\F--Phoenix-Workforce-phoenix-workforce--claude-worktrees-quirky-swartz-a8d6bb\87b7ed99-c965-4108-963a-9f43201a21e5\scratchpad`). Prepared but NOT written (owner chose 20): الأشراف 8/11 and بحرى 4 of 5 named (of 80); thin one-pharmacy-plus-Google: كامولا, دونيه, ثكانات المعادى, كفر بتيس.
- Of the 7 twins above: العصافرة بحرى, المرج الجديده, شارع مصطفى فهمى now have their own pins; دنطيط, السراو, المنشاة have no pharmacies and سنورس (Damietta)'s one pharmacy is in Fayoum — they stay hidden.
- Still hidden with no trustworthy evidence: تكلا, التجنيد, فيكتوريا - شبرا (Google gives Alexandria), الجزيرات, شبراخوم, المطارسريع, راغب, الزينى. Customer Mapping screen (pharmacy in the wrong town): أجا - سوهاج (pharmacy in Aga, Dakahlia, 488 km), شاتانوف (pharmacy in Tala, 48 km), بنى عديسات (Luxor's العديسات + Manfalut's بنى عدى), سنورس Damietta. Master Database screen: المناشى / المناشي البلد (both at المناشي village), دنطيط / دنديط.

**How wrong pins are found:** join `source_of_sales_customer_map` (active) to `geo_locations` `source_type='pharmacy_address'` on label=customer_name and address_text=address, drop the Egypt-centre fallback (26.8206, 30.8025), and flag a brick with ≥3 geocoded pharmacies, most within 4 km of their median, whose pin is >4 km away. Then READ the addresses: the pharmacy geocodes can be the wrong one (غبريال's matched a Ghobrial near Tanta; its pin in Alexandria is right).

**Left alone on purpose (do not re-raise as pin fixes):** غبريال, العياط, ميناء البصل (pin right); بحرى, صقر قريش (too little data); المسير, الأشراف, كوبرى الناموس, الحوامديه, الخانكه (mixed villages; القلج was here too until it was pinned at 21:22); دمنهور شبراخيت (two-town brick); عزبة النخل (the owner's own manual pin). منيل الروضة, النزهه (Alex Center), بنى عبيد (Minia 1) are customer-to-brick problems for the Customer Mapping screen. ش البستان, الزهور, كفر الشراقوة were held from the first 8 (ambiguous addresses).

**What would undo them:** `buildBrickCentroids` Pass 1 (`src/lib/sales/normalizer/brick-centroids.ts`) used to upsert `field_gps` over any pin. Checked on origin/main at 21:30 Cairo (2aa154aee): `fieldGpsMayReplacePin` now keeps a manual pin and any `success` pin that `pinConfidence` ranks above field GPS. `google_geocode` scores 85 against field GPS's 40, so every pin re-pinned tonight is kept. A `shared_fallback` row (شها, the 7 twins) or a `checkin_gps` row is still replaceable. Rep GPS is never ground truth (owner). Related: [[sos-monthly-closing-is-the-only-sales-truth]] is unaffected — no customer or sales moved.
