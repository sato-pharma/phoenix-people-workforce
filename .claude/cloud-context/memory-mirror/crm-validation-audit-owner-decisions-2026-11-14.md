---
name: crm-validation-audit-owner-decisions-2026-11-14
description: "The owner's four Phoenix CRM place-validation decisions of 14 Nov 2026, and where the clean-up pre-image is kept"
metadata:
  node_type: memory
  type: project
  originSessionId: 35865430-d8bd-40fc-bfbf-9c1a39e7ddea
  modified: 2026-11-14T04:46:55.737Z
---

Owner's answers, 14 Nov 2026 ~05:10 Cairo, during the doctor and polyclinic validation audit (asked as multiple choice):

1. **"Approve it after all" with something in the way** (a dropped customer, a retired building, a door captured again) → **stop and say why**. Never approve silently past it.
2. **A customer seated in a polyclinic whose board does not name him, but validated at a clinic of his own** → **he stays in** the KPIs on his own clinic.
3. **The night re-read of a timetable the door lost finds the board does not name him** → **record only**. It writes the place's own check and nothing else: no notice, no hold, no un-validation.
4. **Live clean-ups he approved, all three run the same day**: 105 stale "Validate again" notices archived; the one stale rejected review corrected to approved; the 15 same-door twin places merged into one each.

**Why:** these are his decisions, not defaults; a later session "tidying" any of them back would undo his word. The rules themselves are in `.claude/rules/phoenix-crm-validation.md` and `.claude/rules/phoenix-crm-polyclinic.md`; the account is the section "The validation audit — 14 Nov 2026" in `docs/phoenix-crm-shared-places.md`.

**How to apply:** before changing the approve-after-all path, the KPI membership of a seated customer, or `runLostTimetableRereads`, read those rules first. The pre-image of the three clean-ups is the production schema `phoenix_crm_backup_20261114` (tables `stale_notice_states`, `stale_review`, `twin_merge_pairs`, `twin_merge_places`, `twin_merge_visits`, `twin_merge_plan_items`) — never drop it without his word; production has no point-in-time recovery.

Not asked, and left as it was (my default, not his decision): no new integrity flag for "no name on the sign".

**The four enhancement decisions, the same morning ~06:10 Cairo** (multiple choice, after "build the five enhancements in one PR"):

5. **Pins to check** → **leave it**. Nothing changes there.
6. **The no-visit exception** → **add days in a row** ("No visit for 8 working days in a row"; same row, same rung, same people told).
7. **Buildings whose timetable keeps failing** → **list + declare**: a list for the deciders, and a Super Admin button "This building has no timetable" that marks the building and validates nobody.
8. **The stray seat حضانه احمد محروس** (validated in a retired building) → **send back**. Done at 06:37 Cairo through the board's own refusal; the rep validates again.

My reading, not his words: the Google refusal keeps "within 150 m" because that is the rule he sent the reps on 3 Oct. The pre-image of the left-items data change is in the same schema: `left_items_reopen_stamps` (237), `left_items_copied_pins` (641), `stray_seat_customer`, `stray_seat_place`, `stray_seat_review`, `stray_seat_visits`.
