---
name: vacant-seat-lists-loaded-from-previous-reps-plans
description: "19 Oct 2026 (owner's pick \"Load all 18\") — 2,263 pending reference customers minted on 18 vacant rep seats from each previous rep's iReports360 PLAN history, own-area bricks only, load_id aaee3c37-81dd-40c0-be69-2811eeb914ed; the iReports360 account name \"( Area / X )\" names the line (A=AIF, C=CNS, P=Pedia, E=old AIF, F=old Pedia), which is how a rep with no occupancy row is traced."
metadata:
  node_type: memory
  type: project
  originSessionId: 6fab24c1-f401-400a-a025-4ef8bd24109a
  modified: 2026-10-19T11:55:39.849Z
---

On 2026-10-19 (Cairo) the owner chose "Load all 18 (Recommended)" for the 21 vacant rep seats that read empty in Phoenix CRM.

- Written: 2,263 `phoenix_crm_customers` rows, `origin='reference'`, `status='pending'`, `reference_contact_crm_id` = the vendor contact id, `created_by_hr_id` = the previous rep (B-10 for the unnamed resigned AIF Haram-Faisal account 1528). Split 239 AM / 1,845 PM / 179 Pharmacy. Each has a `customer_pending` event and each seat a `list_loaded` event, actor B-10, `details.source = 'ireports360_plan_history'`, `details.load_id = 'aaee3c37-81dd-40c0-be69-2811eeb914ed'`.
- Rollback = delete the customers whose `customer_pending` event carries that load_id, while still pending and placeless.
- Why `reference` and not `phoenix_crm_load_list_customers`: that loader mints `origin='new'`, and the add-path trigger then gives each doctor a NEW own id — a second identity for a doctor the vendor already numbers.
- First pass: only doctors whose `crm_contacts.brick_id` sits in the seat's own area (via `source_of_sales_bricks.area_code`). Then he picked "Add all 184": 184 neighbouring-area doctors went to the vacant seat that covers their area, under the same load_id with `details.part = 'neighbouring_area'`, for 2,447 rows in all.
  - 🔴 **CNS has NO seat in GZ3 (Imbaba) or D17 (Kafr El-Sheikh 2).** Those doctors belong to CNS Dokki (GZ2) and CNS Kafr El-Sheikh 1 (D16). Never filter a CNS patch by its seat's own area code alone.
  - The 6 that sit on occupied seats stayed out.
  - Proven afterwards: 0 duplicate (seat, vendor id) pairs and 0 doctors on two live lists in one line.
- List type: B-177's own AIF-era vendor assignment, else the contact's open assignment mode, else any assignment, else speciality (hospital/contract/insurance/polyclinic → AM, Pharmacy → Pharmacy, else PM).
- Tracing a rep with no `au.occupancy_history`: `ireports360_crm_identity_resolutions.crm_name` and `employees.crm_username` read "( Area / X )". Verified: B-104 "Helwan-Maadi / E" is line anti_infective; B-99 and B-109 "/ F" are pedia. A resigned rep's later plan rows keep `agent_crm_id` with `agent_hr_id` NULL (see `crm-null-plan-hrid-means-leaver-not-defect`).
- CNS Kafr El-Sheikh 1 used account 1453, which is unlabelled: it is the only KFS account whose dates match B-144's time on the seat (B-169 is 1475, the AIF rep is 1406).
- AIF Heliopolis, AIF Suez and Pedia Heliopolis have no previous-rep data at all: their accounts never planned a doctor and visited only one contact.
  - Heliopolis was filled anyway, on his pick "Load them as they are". 172 pending reference customers (121 AIF, 51 Pedia), actor B-10, `details.source = 'ireports360_area_candidates'`, load_id `7cab5c6f-35a6-4132-bea2-5cd2d0413f19`.
  - Who: iReports360 contacts with a Heliopolis (CA1) brick, last visited in 2026, in a speciality holding at least 1% of that line's live lists, and on no list of that line.
  - Same-name duplicates in the vendor master were folded to the most recently visited record.
  - Suez has no iReports360 doctor at all (nor Ismailia, OT9, which the same seat "AIF Ismailia and Suez rep" covers); its blank sheet is in `xlsx/`.
- Same day, his "suggestions?" picks: Source of Sales PHARMACIES went in through the app's own sheet loader (`phoenix_crm_load_list_customers`, origin `new`, `details.source = 'source_of_sales_pharmacies'`, one load_id per seat). 132 on five Pedia seats that held none (Cairo East 1 35, Cairo East 2 36, Cairo West 24, Nasr City 19, Sharkia 2 18; Pedia buyers since July) and 6 on AIF Suez (AIF buyers in 2026). Left out: wholesalers ("لتجارة", "شركة", "مخزن"), hospitals, net-zero buyers, a Sharm pharmacy, and one pharmacy that two distributors spell differently.
  - 🔴 Source of Sales client names carry distributor tags ("ن.م", "الجديدة", "- <district>"). Strip them before comparing, or one pharmacy loads twice.
  - A same-name pharmacy on another governorate's list (e.g. "صيدلية رضا") is a different shop, not a duplicate.
- Three lists were longer than the line's largest live list: Pedia Dokki 207 PM, AIF Behira 2 193 PM + 23 AM, CNS Kafr El-Sheikh 1 138 PM.
  - 🔴 He DECLINED the DELETE at the prompt, then picked "Mark them dropped". The 126 least recently visited are now `status='dropped'`, `dropped_reason='other'`, with a note starting "List longer than any live rep's".
  - Each has a `customer_dropped` event with `why: 'vacant_list_trimmed'` and `previous_status: 'pending'`, so it can be restored.
  - Ranking: `crm_contacts.last_visited_on` first, then the latest `ireports360_plan_entries.plan_date`. Do not use `crm_visits_unified` here: it timed out.
  - Never delete loaded rows. Drop them instead.
- 🔴 **iReports360 holds many doctors twice — same name, two contact ids (72 of the 243 Heliopolis records).** The sheet parser refuses a repeated list + lower-cased name, so a pre-filled sheet must merge those records into one row first.

**Why:** his "load the previous rep's lists for the 21 empty vacant areas", 19 Oct 2026.
**How to apply:** for a seat that reads empty, look for the rep through the account name before calling it "no data". A new vacant-seat load reuses this shape: reference rows, own-area only, no duplicates within the line. Related: [[crm-null-plan-hrid-means-leaver-not-defect]].
