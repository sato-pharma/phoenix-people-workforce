---
name: customer-mapping-file-audit-and-fix
description: "Audited and corrected Customer_Mapping_All_49712_Confidence_Colored.xlsx (a 49,712-row per-customer brick remap candidate) — built against the pre-reallocation brick master, now fixed to point at the confirmed-live 668-brick set, plus Area/Region columns added and 1,235 duplicate keys resolved."
metadata: 
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-07-24T09:29:08.125Z
---

2026-07-24, same day as [[reallocation-668-bricks-full-plan-live]]. Owner supplied
`Customer_Mapping_All_49712_Confidence_Colored.xlsx` (Desktop) — a full per-customer brick-remap
candidate, 49,712 rows, 1 sheet "All Customers", 16 columns (Customer Code/Distributor/Name/Address,
Old+New Brick ID/Name, Old+New Block ID/Name, Confidence, Decision Status, Action). Not something I
built — asked to deep-audit it.

**Honest data-completeness split, methodologically sound:** 29,121 of 49,712 rows (58.6%) have no
Customer Name or Address at all — correctly marked Confidence=Unknown / Action="KEEP (UNVERIFIED)"
rather than a fabricated decision. Of the 20,591 rows with real data: 11,242 KEEP, 8,410 CHANGE, 939
REVIEW (every Low-confidence row routes to REVIEW, none silently kept/changed).

**Critical finding: built entirely against the pre-reallocation brick master.** Diffed its 682 distinct
"New Brick ID" values against the exact 668-brick set confirmed live that same day — 92 didn't exist.
Verified with 100% precision: all 92 exactly match the 104 bricks retired during today's reallocation
work (0 unexplained). 2,732 of 49,712 rows (5.5%) pointed at a now-dead brick. The underlying
address-matching logic itself looked sound though — spot-checked CHANGE decisions landed on the same
fine-grained sub-bricks created earlier that day (e.g. B10-13/B10-14, from the 210-brick completion
batch) — a staleness problem, not a broken methodology.

**Second finding: Old/New Block Name columns are wrong file-wide.** They show the AREA name, not the
real block description, for every block checked (e.g. B1 shown as "Heliopolis", real name "الكوربة –
شارع الميرغنى"). New Block Name is correct only for rows with a genuine AI decision; "Unknown" rows
just carried the same wrong label forward. Brick ID/Name columns were reliable; block-name columns
were not.

**Fix built and independently verified:** `Customer_Mapping_All_49712_Confidence_Colored_CORRECTED.xlsx`
(Desktop) — same file, only specific cells edited (openpyxl non-read-only load + targeted cell writes,
so the original conditional-formatting rules and everything else stayed intact):
- Re-routed all 91 non-B25-43 stale New Brick IDs through the already-built old->new crosswalk
  (124-row Brick Comparison crosswalk + the 13 direct 14-uncovered-bricks mappings, including the
  owner-confirmed B106-79->B5-64 override), also fixing New Block ID/Name to match.
- B25-43 (73 rows) got its own per-customer address classification, reusing the same rules from
  [[reallocation-14-uncovered-bricks]]'s split proposal: 65 resolved (38 Badr, 22 Sadat incl. inferred,
  3 badr_inferred_village, 2 Kom Hamada), 8 honestly left as "NEEDS MANUAL REVIEW" (2 genuine
  cross-governorate outliers — Ain Shams/Cairo, Tahrir Square/Cairo, Tal El-Kebir/Ismailia — and 5 with
  no usable address signal) rather than guessed.
- Old/New Block Name fixed file-wide against the real 168-block master (49,688 Old + 26,067 New cells
  corrected).
- **Verified independently after the fact** (not trusting the script's own log): re-scanned the
  corrected file's actual New Brick ID / New Block ID values against the confirmed-live 668/168 sets.
  Result: 49,704 of 49,712 rows now point at a fully valid, currently-live brick; the only 8 remaining
  are the honestly-flagged B25-43 unresolvables. 0 invalid New Block IDs anywhere.

**Still NOT done — this is a corrected candidate file, not an applied remap.** Nothing has been written
to `source_of_sales_customer_map` (49,712 live rows) — that mutation is still explicitly deferred,
same as it's been all session, pending its own separate go-ahead. This file is now the best available
input for that step whenever the owner says go.

**Follow-up same day: added geography columns + resolved duplicates, both independently re-verified.**
Owner asked what was still missing; answer (grounded, not padded): no Area/Region columns at all, and
1,235 duplicate (Distributor Code, Customer Code) keys. Owner said go ahead on both.
- Added 4 columns (New Area Code/Name, New Region Code/Name) via New Brick ID -> the same verified
  668-brick master lookup used throughout. Left blank (not guessed) for the 8 B25-43
  NEEDS-MANUAL-REVIEW rows, since New Brick ID is invalid for those.
- Investigated the 1,235 duplicate keys before touching anything: all 1,235 turned out to be 100%
  exact-identical row pairs (same Distributor+Customer appearing twice, every column equal) — zero
  conflicting New Brick ID assignments. Resolved by moving the second occurrence to a new
  "Duplicate Rows Removed" sheet (with Original Row # for traceability) rather than silently deleting;
  kept exactly one row per key in "All Customers" (48,477 rows + 1,235 in the audit sheet = 49,712,
  matches the original total).
- Conditional formatting (the Confidence-based row coloring, dxfId 1-4 keyed on column N) is
  column-append-safe by construction (new cols appended after existing P, so N stays Confidence) but
  row-deletion required manually re-scoping the CF range from A2:P49713 to A2:T48478 — openpyxl does
  NOT auto-update CF sqref on delete_rows, a real gotcha worth remembering for any future xlsx-surgery
  task that both deletes rows and needs to preserve conditional formatting.
- First save attempt silently crashed mid-script with zero output because the file was open in Excel
  on the owner's machine (traced via the `~$...xlsx` Windows lock-file, which encodes the OS username
  of whoever has it open) — `wb.save()` hit a Windows file-lock PermissionError. No data lost (backup
  already made pre-save); simply waited for Excel to close and retried successfully. **General lesson:**
  if a background openpyxl save on a Desktop file returns a "stopped"/no-completion-record
  notification with an empty output log, check for a `~$<filename>` lock file next to the target
  before assuming a bug in the script.
- Independently re-verified the SAVED file from scratch afterward (fresh brick->area/region lookup,
  not reusing the build script's in-memory dict; fresh duplicate-key scan; fresh CF introspection) —
  all checks passed, including 0 area/region mismatches and 0 residual duplicate keys.
- Backup of the pre-this-change version saved alongside it:
  `Customer_Mapping_All_49712_Confidence_Colored_CORRECTED_v1_backup.xlsx`.
