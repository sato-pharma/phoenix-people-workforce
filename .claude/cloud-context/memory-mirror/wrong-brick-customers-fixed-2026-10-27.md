---
name: wrong-brick-customers-fixed-2026-10-27
description: "35 customer-map rows moved off منيل الروضة, النزهه (Alex) and بنى عبيد (Minia) on the owner's 'ok fix' 2026-10-27, plus the EL ISMAELIA SQ alias re-pointed; history NOT re-pointed"
metadata:
  node_type: memory
  type: project
  originSessionId: 7e3f9218-9af1-45ab-823d-b2466e264784
  modified: 2026-10-27T18:37:45.357Z
---

On 2026-10-27 (~21:40 Cairo, the owner's "ok fix" to the wrong-brick report) 35 active `source_of_sales_customer_map` rows were moved in one guarded SQL block. Each now has source `owner-chat-fix-2026-10-27`, mapped_by `B-10` and confidence 100. Confidence 100 makes them owner-verified to `loadOwnerVerifiedMapKeys`, so a sheet re-import will not move them back. There is one `source_of_sales_mapping_audit` row per move (entity customer_map, action edit, before/after json), 36 including the alias.

- **Off النزهه B177-2 (Alex AB2), 20 rows, all to Heliopolis CA1:**
  - مساكن شيراتون: 7
  - النزهه الجديدة: 6
  - ش عمار بن ياسر: 2
  - ميدان الحجاز: 2. These are ناديه and جون سامي, both "امام نادي الشمس". The evidence is IS ابرام across from the club and the owner-placed ميرا at امين الشمس الحجاز.
  - ميدان سانت فاتيما: 1
  - ميدان هليوبوليس: 1 (مقصود)
  - The exception: الفخراني 70/72 الفراهدة went to اللبان (AB3).
- **Off منيل الروضة B190-6 (CA5), 11 rows, all to CA1:**
  - ميدان الإسماعيليه: 5
  - المحكمة: 2
  - سفير: 2
  - ميدان الجامع: 1
  - ش هارون الرشيد: 1
- **Off بنى عبيد B217-1 (UE1), 4 rows:** all to بنى عبيد الدقهلية B188-5 (D23). Two of them are منال اشرف, which overrode his own 11 Sep rest99 ruling after he saw it flagged.
- **Alias 6536** `EL ISMAELIA  SQ` (Ibn Sina) was re-pointed from B190-6 to B196-11. It was the root cause of the منيل الروضة rows.
- **History was NOT re-pointed.** Unlocked import rows still sit on the old areas: Ibn Sina Jan–Jun 2026 plus Aug 2025, about 35 rows across 9 customers; July–Sept are locked. That is decided by reconcile-apply on SoS Mapping (Super Admin).
- **Left on purpose:** جون سامي's Seif record CAI102804 is still on روكسى (Heliopolis, same area), from today's archive-file import.
- **Backup:** `wrong-brick-fix-backup-2026-10-27.json` in session 7e3f9218's scratchpad. The audit rows' before_json holds the same data.

**Two more at 21:36 Cairo** (owner: "fix تغريد and ياقوت", after the Cairo-on-Alexandria audit of all of today's archive imports):
- EG 44092 تغريد - باب اللوق (10 ش محمد محمود) moved from ش مصطفى كامل (Alex East) to باب اللوق (Down Town).
- RM 1150224 ياقوت (80 ش شبرا) moved from دمنهور شبراخيت (Behira 1) to روض الفرج (Cairo West).
- Same source, confidence and mapped_by as above, with 2 audit rows. Neither record had any import rows, so no money moved.
- Backup: `cairo-on-alex-fix-backup-2026-10-27.json` in the same scratchpad.
- **Moved next, on the owner's word ("fix اسماء احمد حبيبه onto إدكو"):** IS 454421 اسماء احمد حبيبه (ش احمد عرابى ادكو), from المنتزه (Alex East) to إدكو (Behira 2). It had no import rows; 1 audit row; the backup is in the same JSON.
- **Left unfixed (only reported):**
  - Amreya pharmacies (كوبري شربات / القرية البيضاء) are on مرسى مطروح.
  - عصام عفيفي (Borg El Arab) is on مرسى مطروح.
  - EG محمد الصباغ (Kafr El Dawwar) is on أبو حمص.
- **Audit result:** no other Cairo pharmacy sits on an Alexandria-region brick.

Related: [[brick-pins-hand-corrected-2026-10-27]] (the pin work that surfaced these three bricks).
