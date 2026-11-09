import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";

import { stepDefinition } from "./step-definitions.ts";

import {
  canBeUnbackedCharge,
  columnLabel,
  isDriftComparableField,
  isMoneyField,
  isUnbackedCharge,
  MODULE_SOURCED_STEP_KEYS,
  pricedMoneyField,
} from "./module-sourced-steps.ts";
import type { DraftRow, StepKey, StepRow } from "./types.ts";

/**
 * Has the Deductions module changed its mind since this step was confirmed?
 *
 * WHY THIS EXISTS. Confirming a step copies the figure the module is proposing onto the run's own
 * row, and the payroll engine then reads that row — not the module — when it works out what
 * everybody is paid. That copy is load-bearing and must stay: clearing it does not fall back to the
 * module, it reads as zero, which would wipe every deduction HR accepted rather than typed.
 *
 * The cost of the copy is that it is taken once and never looked at again. Mark a candidate "Do Not
 * Take Action" in the module after the step was confirmed and the employee is still charged, with
 * the breakdown underneath showing no lines at all — the money stopped coming from the module and
 * nothing said so. Approve a candidate afterwards and it contributes nothing, because the copy
 * outranks it. Your rule is that payroll pays what was approved in the module; a copy taken once
 * quietly changes that to what was approved at one particular past moment.
 *
 * WHY A SNAPSHOT AND NOT A PLAIN COMPARISON. Comparing the stored figure against what the module
 * says now cannot tell two very different things apart: a figure HR deliberately overrode, which
 * must be left exactly alone, and a figure the module has since changed, which is the one worth
 * raising. Both simply "differ". So the confirm records what it was proposing at the time, and the
 * comparison is then between the module's answer THEN and its answer NOW — which is a fact about
 * the module, not about the person editing.
 *
 * Without that, every deliberate override shows up as a warning, the warning is always on, and it
 * stops being read — which is the failure that matters most for a check that only pays off on the
 * rare month something moved.
 */

// The step list lives in a browser-safe file (this one reaches the database client through feeders.ts),
// so the wizard can read it too. Re-exported so every existing import keeps working.
export {
  canBeUnbackedCharge,
  columnLabel,
  isDriftComparableField,
  isMoneyField,
  isUnbackedCharge,
  MODULE_SOURCED_STEP_KEYS,
  pricedMoneyField,
};

/**
 * The rows that STOP the Part 2 confirm: a figure nobody chose, on the column the sheet pays.
 *
 * Two filters, and both have cost a real false block on the live September 2026 run. `!overridden`
 * is the owner's 2026-10-06 rule — a figure somebody typed is their decision and still wins.
 * `isMoneyField` is the second: a day count pays nothing, and the money it would price has its own
 * row whenever it moved. See `isMoneyField` for the two day-count rows that held the month up.
 */
export function blocksPart2Confirm(row: ModuleDriftRow): boolean {
  return !row.overridden && isMoneyField(row.stepKey, row.field);
}

/** The key the snapshot is stored under, inside the step state's existing jsonb summary. */
export const RECOMMENDED_AT_CONFIRM_KEY = "recommendedAtConfirm";

/** compact HR id -> field key -> what the system was proposing when the step was confirmed. */
export type RecommendationSnapshot = Record<string, Record<string, number>>;

export type ModuleDriftRow = {
  hrId: string;
  fullName: string;
  stepKey: StepKey;
  /** The step field that moved, e.g. "crm". */
  field: string;
  /** What the module was saying when the step was confirmed. */
  proposedAtConfirm: number;
  /** What the module says now. */
  proposedNow: number;
  /** What the run will actually charge — the figure on its own row. */
  charged: number;
  /**
   * True when the charged figure is not the one the module proposed at confirm. It still stands and
   * never blocks; this row is context, not a problem.
   *
   * It does NOT mean a person typed it. Two steps can write one draft column — a leaver's Part 1
   * Resignations CRM and the Part 2 CRM step both land in `crm` — so a figure another step's confirm
   * wrote differs from this step's snapshot just the same. Who actually set it is `chargeSource`,
   * read from the cell history; the wording says "typed" only when that history says a person did.
   */
  overridden: boolean;
  /** Who last wrote the charged figure, from automated_payroll_draft_cell_history. Absent = not looked up. */
  chargeSource?: ChargeSource;
};

/**
 * The cell history's answer to "who set the figure this run charges".
 *
 * `typed` — a person saved it on a step (inline or by uploaded sheet).
 * `step` — a step's confirm or a Part 1 confirm/reopen wrote it, carrying a recommendation.
 * `system` — a resync after a Deductions push or an expense change.
 * `unknown` — no history entry: the figure was written before the history began (2026-10-07).
 */
export type ChargeSource = {
  kind: "typed" | "step" | "system" | "unknown";
  name: string | null;
  stepKey: string | null;
  at: string | null;
};

/** The draft column a step field is stored in — a step field's key IS its DraftRow key, camelCase. */
export function draftColumnForField(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Classify a history entry's reason into who set the figure. */
export function chargeSourceKind(writeReason: string | null | undefined): ChargeSource["kind"] {
  if (writeReason === "step_saved") return "typed";
  if (writeReason === "deduction_resync" || writeReason === "expense_resync") return "system";
  if (writeReason) return "step";
  return "unknown";
}


export type ModuleDriftReport = {
  rows: ModuleDriftRow[];
  /**
   * Rows where the run is about to charge a figure the module no longer proposes AND nobody chose
   * it by hand. These are the ones that need a decision.
   */
  staleCharges: number;
  /** Rows where the module moved but a human's own figure is in force. Shown, never counted as a problem. */
  overriddenButMoved: number;
  /**
   * Rows where the module proposes NOTHING and never did, yet the run charges real money.
   *
   * Not a stale charge — nothing drifted — so it never blocks. It is counted apart from
   * `overriddenButMoved` because the module did not move for these at all, and saying it did
   * would be false in the one sentence a person actually reads.
   */
  unbackedCharges: number;
};

/** The three counts, from one set of rows — so merging and detecting can never disagree. */
function tally(rows: ModuleDriftRow[]): ModuleDriftReport {
  return {
    rows,
    staleCharges: rows.filter(blocksPart2Confirm).length,
    overriddenButMoved: rows.filter((row) => row.overridden && !isUnbackedCharge(row)).length,
    unbackedCharges: rows.filter((row) => isUnbackedCharge(row)).length,
  };
}

/**
 * What the system proposed for each employee, to be stored alongside the confirm.
 *
 * The step key is required rather than optional so a display-only field cannot be recorded by a
 * caller that simply did not pass it: a `notPersisted` field has no draft column, so storing what it
 * proposed records a figure nothing can ever charge — the 30-working-days rows that blocked the live
 * September 2026 run were read straight out of a snapshot written this way. `detectModuleDrift`
 * refuses them on the way out too; both ends, because the snapshots already stored carry them.
 */
export function snapshotRecommendations(stepKey: StepKey, rows: StepRow[]): RecommendationSnapshot {
  const snapshot: RecommendationSnapshot = {};
  for (const row of rows) {
    if (row.readOnly) continue;
    const compact = compactHrKey(row.hrId);
    if (!compact) continue;
    const fields: Record<string, number> = {};
    for (const [field, value] of Object.entries(row.recommended ?? {})) {
      if (!isDriftComparableField(stepKey, field)) continue;
      if (typeof value === "number" && Number.isFinite(value)) fields[field] = value;
    }
    // An employee the step proposed nothing numeric for contributes no entry rather than an empty
    // object: absent and "proposed nothing" must stay distinguishable when the snapshot is read
    // back, because only the first means "this step predates the snapshot".
    if (Object.keys(fields).length > 0) snapshot[compact] = fields;
  }
  return snapshot;
}

/** Read a snapshot back out of a step state's summary, tolerating a step confirmed before it existed. */
export function snapshotFromSummary(summary: Record<string, unknown> | null | undefined): RecommendationSnapshot | null {
  const raw = summary?.[RECOMMENDED_AT_CONFIRM_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const snapshot: RecommendationSnapshot = {};
  for (const [compact, fields] of Object.entries(raw as Record<string, unknown>)) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    const numeric: Record<string, number> = {};
    for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) numeric[field] = asNumber;
    }
    if (Object.keys(numeric).length > 0) snapshot[compact] = numeric;
  }
  return snapshot;
}

/**
 * Compare what the module proposed at confirm against what it proposes now.
 *
 * Pure, so the rule is testable without a database — the caller supplies the freshly computed rows
 * and the snapshot that was stored.
 *
 * A step confirmed before snapshots existed passes a null snapshot and reports nothing. Silence is
 * correct there: with no record of what was proposed at the time, every comparison would be a
 * guess, and a guess presented as a finding is worse than no finding.
 */
export function detectModuleDrift(input: {
  stepKey: StepKey;
  rows: StepRow[];
  snapshot: RecommendationSnapshot | null;
  /**
   * compact HR id -> field key -> the figure FROZEN on the run's own draft row, where one exists.
   *
   * Optional, and only ever narrows what `charged` reports: a draft column that is null means
   * nothing was persisted for that field, which is a real 0.00 on the sheet rather than the live
   * recommendation `row.values` falls back to. Omitting it keeps the pre-2026-10-06 reading.
   */
  chargedByCompact?: Record<string, Record<string, number>>;
  /**
   * Whether the run's Part 1 is confirmed. Once it is, a LOAN typed on Part 1 with no module line
   * behind it is never reported as unbacked: it is already inside the frozen first part, paid, and
   * nothing is left to clear (owner, 2026-11-09, of Mahmoud Ibrahim Ahmed Mohamed's 1,250.00:
   * "already deducted from him first part"). The LOAN column only — a typed "Other" figure is still
   * reported, because that is the shape of September's double-charged lateness.
   */
  part1Confirmed?: boolean;
}): ModuleDriftReport {
  const rows: ModuleDriftRow[] = [];
  if (!input.snapshot) return tally(rows);

  for (const row of input.rows) {
    if (row.readOnly) continue;
    const compact = compactHrKey(row.hrId);
    // AN EMPLOYEE ABSENT FROM THE SNAPSHOT PROPOSED NOTHING AT CONFIRM — WHICH IS A COMPARISON, NOT
    // A REASON TO SKIP THEM. Skipping was the original reading, and under the push gate it blinded
    // this check to the commonest direction of drift there is: nothing → something. A step is
    // confirmed; the Super Admin pushes a line afterwards (owner rule 2026-09-22 — the PUSH, not the
    // approval, is what releases money); the module now proposes a figure for somebody it proposed
    // nothing for before, and the run is still charging the zero it froze.
    //
    // Measured on the live September 2026 run, 2026-10-06: `p1_fingerprint` was confirmed on
    // 2026-09-24 carrying an EMPTY snapshot — correctly, because nothing was pushed yet and the step
    // emits no row at all for an employee worth 0.00 — and the eight lines pushed on 2026-10-06
    // (3,333.32 EGP across two one-part employees) moved the module's answer from nothing to a real
    // figure while this report stayed silent.
    //
    // A `null` snapshot above still means something different and still returns silence: that step
    // was confirmed before snapshots existed, so there is no record to compare against at all.
    const proposedThen = (compact ? input.snapshot[compact] : undefined) ?? {};
    const fields = new Set([...Object.keys(proposedThen), ...Object.keys(row.recommended ?? {})]);

    for (const field of fields) {
      // A FIELD WITH NO DRAFT COLUMN CHARGES NOTHING, SO THERE IS NOTHING TO COMPARE — and comparing
      // it anyway blocked the live September 2026 run with 11 working-days rows and 0.00 of money.
      // See `isDriftComparableField`.
      if (!isDriftComparableField(input.stepKey, field)) continue;
      const atConfirm = proposedThen[field] ?? 0;
      const now = row.recommended?.[field];
      if (typeof now !== "number" || !Number.isFinite(now)) continue;

      // What the run will really charge. `row.values` falls back to the live recommendation when the
      // draft column is null (`pick` in recommend.ts), and a row that was never persisted at confirm
      // is exactly the absent-from-snapshot case — so reading `values` alone would report the figure
      // the module wants rather than the zero the sheet will pay, and then label it an override
      // because the two differ. `charged` is therefore the draft's own figure where the row carries
      // one, and the confirm-time proposal otherwise.
      // HAVING the employee's draft row is the authority, field by field: a column that carries no
      // number is NULL, which the sheet pays as 0.00 — it is not an invitation to fall back to the
      // recommendation. Without the draft (an older caller omits the map) the previous reading stands.
      const draftFields = compact ? input.chargedByCompact?.[compact] : undefined;
      const charged = draftFields
        ? typeof draftFields[field] === "number" && Number.isFinite(draftFields[field])
          ? draftFields[field]
          : 0
        : typeof row.values?.[field] === "number"
          ? (row.values[field] as number)
          : atConfirm;

      // THE MODULE HAS NOT MOVED. Normally there is nothing to say, and saying it anyway is what
      // puts the banner permanently on: a figure somebody trimmed from a real proposal (900 cut to
      // 700) is their decision, and the module standing still is not news about it.
      //
      // THE ONE EXCEPTION IS A CHARGE THE MODULE PROPOSES NOTHING FOR AND NEVER DID. There is no
      // approved deduction behind a piastre of it, so it is not an adjustment OF anything — and
      // because both sides of the comparison are 0.00, this early return hid it completely: not
      // from the drift report, not from the Part 2 gate, and not from `takeCurrentModuleFigures`,
      // whose remedy is a re-confirm that `pick(draft, recommended)` makes a no-op anyway.
      //
      // Measured on the live September 2026 run, 2026-10-09: Nahed Tarek Hassan Omar Hattab (A-10)
      // carried 2,931.00 in Part 1 Other Deductions → Other with no `other` candidate in the month
      // at all, beside a correct 2,933.32 in the Fingerprint column for the same six late days —
      // the same lateness charged twice. Hossam Mohamed Reda AboElftouh Abdelghafar (A-9) carried
      // 400.00 the same way, against a correct 400.00 of fingerprint. 3,331.00 EGP over two people,
      // and every existing check silent.
      //
      // It is REPORTED, never blocking and never rewritten: HR may type a manual deduction straight
      // onto the Other tab with no candidate behind it by design, so the figure can be perfectly
      // deliberate. Which it is, is `chargeSource` from the cell history — not something this
      // comparison can know. See docs/approved-deductions-that-never-reached-the-sheet.md.
      //
      // 🔴 AND IT IS A QUESTION ONLY WHERE A DEDUCTION COULD HAVE STOOD BEHIND THE FIGURE: a MONEY
      // field on a step that CHARGES. On the day this exception shipped, every one of the five rows
      // it produced on the live run was an Addition being PAID — a 60,000.00 incentive among them —
      // because no module proposes an Incentive, a Bonus or Overtime and `overtime` is recommended
      // as a literal 0 for the whole population. See `canBeUnbackedCharge`.
      const unbacked = now === 0 && charged > 0 && canBeUnbackedCharge(input.stepKey, field);
      if (now === atConfirm && !unbacked) continue;
      // A typed Part 1 loan once Part 1 is paid — see `part1Confirmed` above.
      if (
        unbacked &&
        atConfirm === 0 &&
        input.part1Confirmed &&
        input.stepKey === "p1_other_deductions" &&
        field === "p1odLoanValue"
      ) {
        continue;
      }

      rows.push({
        hrId: row.hrId,
        fullName: row.fullName,
        stepKey: input.stepKey,
        field,
        proposedAtConfirm: atConfirm,
        proposedNow: now,
        charged,
        overridden: charged !== atConfirm,
      });
    }
  }

  // Biggest MONEY AT STAKE first, and the order is stable between loads so a list read twice reads
  // the same way. For a drifted figure that is how far the module moved; for an unbacked charge the
  // module never moved at all, so movement is 0.00 and ranking by it would bury 2,931.00 of
  // double-charged lateness under a 10.00 drift — the stake there is the whole charge.
  const stake = (row: ModuleDriftRow) =>
    isUnbackedCharge(row) ? Math.abs(row.charged) : Math.abs(row.proposedNow - row.proposedAtConfirm);
  rows.sort(
    (left, right) =>
      stake(right) - stake(left) ||
      left.fullName.localeCompare(right.fullName),
  );

  return tally(rows);
}

/** Merge per-step reports into one, for a whole run. */
export function mergeModuleDrift(reports: ModuleDriftReport[]): ModuleDriftReport {
  return tally(reports.flatMap((report) => report.rows));
}

/** compact HR id -> draft field -> the figure frozen on the run's own row (nulls left out). */
export function chargedFiguresFromDrafts(draftRows: DraftRow[]): Record<string, Record<string, number>> {
  const chargedByCompact: Record<string, Record<string, number>> = {};
  for (const draft of draftRows) {
    const fields: Record<string, number> = {};
    for (const [key, value] of Object.entries(draft as unknown as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) fields[key] = value;
    }
    chargedByCompact[draft.employeeHrIdCompact] = fields;
  }
  return chargedByCompact;
}

/**
 * A step's rows with every STALE figure replaced by what the Deductions module proposes now.
 *
 * WHY. A step shows — and its confirm persists — `pick(draft, recommended)`: a saved figure always
 * wins. So a confirmed figure the module has since moved stays on the row however many times the
 * step is re-confirmed, and the drift block's own remedy ("re-confirm the step to take the module's
 * current figures") did nothing. Worse than nothing: the re-confirm stored the NEW proposal as the
 * snapshot while the row kept the OLD figure, so the row then read as a deliberate override, the
 * block lifted, and Part 2 would have paid the figure the block existed to stop. Measured on the
 * live September 2026 run, 2026-10-07: 13 blocking lines, none of which a re-confirm could clear.
 *
 * Only `!overridden` rows are touched — the figure is still the one the module proposed at the last
 * confirm, so nobody chose it. A figure that differs from that confirm is somebody's decision and
 * stays exactly as it is. A step never confirmed (no snapshot) is returned unchanged. And a DAY
 * COUNT comes only with the money it prices, never alone — see the filter below.
 */
export function takeCurrentModuleFigures(input: {
  stepKey: StepKey;
  rows: StepRow[];
  snapshot: RecommendationSnapshot | null;
  chargedByCompact: Record<string, Record<string, number>>;
}): StepRow[] {
  const candidates = detectModuleDrift(input).rows.filter((row) => !row.overridden);
  const takenMoney = new Set(
    candidates.filter((row) => isMoneyField(row.stepKey, row.field)).map((row) => `${row.hrId}|${row.field}`),
  );
  // A DAY COUNT IS TAKEN ONLY TOGETHER WITH THE MONEY IT PRICES, NEVER ON ITS OWN. Writing the
  // module's current day count beside a figure somebody chose is what turned this remedy into the
  // trap measured on 2026-10-09: Aisha Ehab Mamdouh Hussein (B-79) carried a chosen 1,250.00 of CRM
  // against the module's 1,458.33, and the only way to clear the block was a re-confirm that would
  // have left the row reading "2.50 non-working days priced at 1,250.00". Where the money IS being
  // taken, its day count comes with it — otherwise the row would read 733.33 against 0.00 days.
  const stale = candidates.filter((row) => {
    if (isMoneyField(row.stepKey, row.field)) return true;
    const money = pricedMoneyField(row.stepKey, row.field);
    return money !== undefined && takenMoney.has(`${row.hrId}|${money}`);
  });
  if (stale.length === 0) return input.rows;
  const byHr = new Map<string, Map<string, number>>();
  for (const row of stale) {
    const fields = byHr.get(row.hrId) ?? new Map<string, number>();
    fields.set(row.field, row.proposedNow);
    byHr.set(row.hrId, fields);
  }
  return input.rows.map((row) => {
    const fields = byHr.get(row.hrId);
    if (!fields) return row;
    const values = { ...row.values };
    for (const [field, proposedNow] of fields) values[field] = proposedNow;
    return { ...row, values };
  });
}

/**
 * The Part 2 confirm's refusal when the run is about to pay a figure the module no longer proposes.
 *
 * OWNER DECISION, 2026-10-06: a stale deduction BLOCKS the Part 2 confirm — it is no longer only a
 * banner. The banner alone was the right strength while the gate was the decision, because a figure
 * could only go stale if somebody changed their mind. Under the push gate it goes stale by the
 * ordinary order of work: Part 1 is confirmed, the lines are pushed days later, and the run keeps
 * the zero it froze. On the live September 2026 run that was 3,333.32 EGP of fingerprint deductions
 * against two employees, with the step's own breakdown listing them.
 *
 * ONLY `staleCharges` BLOCKS. A figure somebody typed by hand is their decision and still wins — it
 * is reported beside the block and never causes one. That distinction is the whole reason this check
 * is worth having: a block that fires on every deliberate override would be on permanently, and a
 * gate that is always on is one people learn to route around.
 *
 * NOT acknowledgeable, like the day-collision and part-split blocks beside it. There is nothing to
 * weigh up: the remedy is to re-confirm the named step, which takes the module's current figure and
 * is an ordinary action — a Part 1 step stays confirmable while the run is in Part 2.
 */
export function describeModuleDriftBlock(report: ModuleDriftReport): string {
  const stale = report.rows.filter(blocksPart2Confirm);
  const steps = [...new Set(stale.map((row) => stepDefinition(row.stepKey).title))];
  const sample = stale
    .slice(0, 5)
    .map(
      (row) =>
        `${row.fullName} (${row.hrId}) is set to ${row.charged.toFixed(2)} and the Deductions module now says ${row.proposedNow.toFixed(2)}`,
    );
  const more = stale.length > 5 ? ` …and ${stale.length - 5} more.` : "";
  const overridden =
    report.overriddenButMoved > 0
      ? ` (${report.overriddenButMoved} more moved too, but carry a figure different from the one confirmed — those still stand and are not blocking.)`
      : "";
  return (
    `${stale.length} figure(s) on this run no longer match the Deductions module, so confirming now ` +
    `would pay the wrong amount. ${sample.join("; ")}${more} ` +
    `Re-confirm ${steps.join(" and ")} to take the module's current figures, then confirm Part 2.${overridden}` +
    describeUnbacked(report)
  );
}

/**
 * The unbacked-charge sentence, appended to whichever summary is being written.
 *
 * Separate from the drift wording on purpose: these rows did NOT drift, so folding them into "the
 * module moved" would state the one thing that is not true about them.
 */
function describeUnbacked(report: ModuleDriftReport): string {
  if (report.unbackedCharges === 0) return "";
  const unbacked = report.rows.filter(isUnbackedCharge);
  const total = unbacked.reduce((sum, row) => sum + row.charged, 0);
  const sample = unbacked
    .slice(0, 5)
    .map((row) => `${row.fullName} (${row.hrId}) ${row.charged.toFixed(2)} in ${columnLabel(row.stepKey, row.field)}`);
  const more = unbacked.length > 5 ? ` …and ${unbacked.length - 5} more.` : "";
  return (
    ` ${report.unbackedCharges} charge(s) totalling ${total.toFixed(2)} have no approved deduction behind them` +
    ` at all — the module proposes nothing for them and never did: ${sample.join("; ")}${more}` +
    ` Check each against the other columns on the same row before confirming. Nothing here blocks:` +
    ` a manual deduction entered straight onto the step carries no module line by design and is correct.`
  );
}

/** One line for a banner, an error message or the audit log. */
export function describeModuleDrift(report: ModuleDriftReport): string {
  if (report.staleCharges === 0 && report.overriddenButMoved === 0 && report.unbackedCharges === 0) {
    return "Every confirmed figure still matches the Deductions module.";
  }
  const stale = report.rows.filter(blocksPart2Confirm);
  const sample = stale
    .slice(0, 5)
    .map(
      (row) =>
        `${row.fullName} (${row.hrId}): confirmed at ${row.proposedAtConfirm.toFixed(2)}, the module now says ${row.proposedNow.toFixed(2)}`,
    );
  const more = stale.length > 5 ? ` …and ${stale.length - 5} more.` : "";
  const overridden =
    report.overriddenButMoved > 0
      ? ` ${report.overriddenButMoved} more moved but carry a figure different from the one confirmed, which still stands.`
      : "";
  if (stale.length === 0) return `No confirmed figure is stale.${overridden}${describeUnbacked(report)}`;
  return (
    `${stale.length} confirmed figure(s) no longer match the Deductions module. ` +
    `${sample.join(" | ")}${more}${overridden}${describeUnbacked(report)}`
  );
}
