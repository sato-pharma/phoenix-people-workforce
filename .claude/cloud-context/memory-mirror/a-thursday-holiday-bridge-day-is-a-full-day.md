---
name: a-thursday-holiday-bridge-day-is-a-full-day
description: "Owner ruling 2026-11-07 — a holiday-bridge deduction on a Thursday is charged as ONE FULL day, never the CRM half day."
metadata:
  node_type: memory
  type: project
  originSessionId: 81e5b0ae-3360-4870-830d-95028704bc19
  modified: 2026-11-06T22:38:09.215Z
---

A Thursday holiday-bridge day is a FULL day (owner, 2026-11-07, his words: "Thursday holiday-bridge day is a FULL day").

The holiday-bridge connector (`src/lib/deductions/connectors/holiday-bridge.ts`) prices every bridge day at `deductionDays: 1`, category `other`, Thursday included — that is CORRECT and stays.

**Why:** the Thursday-is-half rule (owner, 2026-08-02) is a CRM no-activity rule (a Thursday morning is worked). A bridge day is a day taken next to a national holiday, a different charge. PR 72 (2026-11-07) made CRM narrowing price by weight through `scaleDeductionAmountToKeptDates`, which weights ONLY `category === "crm"` — so it never touches a bridge row.

**How to apply:** never apply `sumDetectedDeductionDayWeights` / Thursday weighting to holiday-bridge rows; if a weighting helper is widened beyond `crm`, exclude `holiday_bridge` explicitly. The CRM half-day rule itself lives in the payroll module memory (`.claude/rules/payroll.md`).
