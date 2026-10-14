---
name: a-rep-who-changes-seat-loses-his-list-when-his-assignments-predate-the-move
description: "A Phoenix CRM rep who moves to a new seat gets NO customers and no Validate button when every open crm_contact_assignments row starts before his new seat's effective_from — phoenix_crm_seat_reference files them under his OLD seat; fix by closing the rows the day before and reopening the same rows on the move date (Mostafa Saied, B-177, 14 Oct 2026)."
metadata:
  node_type: memory
  type: project
  originSessionId: fac4157d-bc70-435a-b4af-8dd8b9bf708d
  modified: 2026-10-14T12:11:14.729Z
---

Mostafa Saied (B-177) moved Anti-Infective -> Pedia on 2026-10-01 (SEAT-AIF-REP-AB5 -> SEAT-PED-REP-AB5). His 183 open iReports360 assignments all started 28 Aug / 29 Sep, so `phoenix_crm_seat_reference` attributed them to the seat he no longer held: 0 customers on the new seat, so no "Validate this customer". It is NOT a team-start problem (his team, Pedia Alex-Behira, was never started and did not need to be — the owner said "no start, Mostafa only").

**Fix applied 2026-10-14 (owner: "attach Mostafa Saied's 183 doctors to his Pedia seat"):** closed the 183 rows at 2026-09-30 and opened the same 183 (same contact, agent_crm_id 1483, list, grade, source ireports360) from 2026-10-01, then ran `phoenix_crm_ensure_reference_customers` -> 183 pending customers. The hourly refresh never rewrites an open row's start date, so it holds. Undo: delete his open rows with effective_from 2026-10-01 and set effective_to null on his rows with effective_to 2026-09-30.

**Why:** the other four reps who changed seat since April were fine because their lists were assigned after the move.
**How to apply:** a mover with an empty list and plenty of open assignments — compare assignment `effective_from` with the seat's `au.occupancy_history` spell before blaming the team start. [[a-doctor-the-system-added-twice]]
