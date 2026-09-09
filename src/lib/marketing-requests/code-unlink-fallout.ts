/**
 * What unlinking a distributor code costs the people who were using it.
 *
 * Unlinking is a decision about a CODE. It lands on a PERSON, and until 2026-09-08 nothing looked.
 *
 * `marketing_customer_pharmacies.distributor_code_id` points at a code ROW by identity, and the
 * request form resolves a target THROUGH it: `getMarketingRequestDraftWorkspace` builds
 * `pharmaciesByCustomer` from the link's code id and skips any pharmacy-type venue whose code is
 * not active. That skip is correct — offering a target the server would then refuse is worse — but
 * it means the moment a code goes inactive, every validated link pointing at it drops out of the
 * picker with no error, no amber row, and nothing on screen at all.
 *
 * MEASURED, not hypothetical. The 2026-09-06 apply of the marketing-pharmacy-code-decisions sheet
 * deactivated 8 code rows on the owner's answers. Every answer was right and all 8 stay applied.
 * But 5 validated customer links pointed at those rows, and two customers — احمد السقا (B-119 Saad
 * Salama) and هبه حبيب (B-154 Nermeen Salah) — were left with ZERO selectable targets. Both
 * District Sales Managers then sat in front of a complete request form with a dead Save button
 * reading "Select a target pharmacy" over an empty list. Neither could have fixed it from the form,
 * and nothing told either of them or us. One re-registered her shop as a duplicate venue the next
 * day to get around it, which is how a silent block turns into dirty data.
 *
 * WHY THIS REFUSES RATHER THAN REPAIRS. Re-pointing a stranded link at some other code on the same
 * venue would be inventing a business fact — which code represents a shop is precisely what the
 * workbook exists to ASK. AGENTS.md §2.3: identity is never settled on a session's own inference.
 * So the caller finds the fallout and stops; the answer comes back through the sheet.
 *
 * WHY THE REFUSAL IS NARROW. A link that merely loses ONE of several targets is reported and
 * applied: the customer still works, and blocking a 79-row apply over it would make this guard the
 * thing people learn to route around. Only a customer left with NOTHING stops the run, because that
 * is the case that silently takes a manager's job away from him.
 *
 * Pure on purpose. The SQL that finds these rows belongs to the script that owns the connection;
 * the judgement about what they MEAN is domain logic and lives here, where a test can reach it
 * without a database and without executing a script whose module scope opens production.
 */

/** One validated customer link that points at a code row about to be switched off. */
export type StrandedLink = {
  /** The distributor code on the link, for the operator to recognise the row. */
  code: string | null;
  customer: string | null;
  /** True when this link's customer is left with no selectable target at all. */
  emptied: boolean;
  venue: string | null;
  /** Who captured the venue — the person who will be looking at the empty picker. */
  venue_owner: string | null;
};

/** A target on an existing request that points at a code row about to be switched off. */
export type StrandedTarget = {
  code: string | null;
  request_code: string | null;
  status: string | null;
  venue: string | null;
};

/**
 * The human-readable account of the fallout, one line per affected row.
 *
 * Returns an empty array when nothing is affected, so the caller prints nothing rather than an
 * empty heading — a report that cries wolf on every clean run stops being read.
 */
export function describeUnlinkFallout(
  links: readonly StrandedLink[],
  targets: readonly StrandedTarget[],
): string[] {
  if (links.length === 0 && targets.length === 0) return [];

  const lines: string[] = [
    `VALIDATED LINKS POINTING AT CODES THIS RUN SWITCHES OFF: ${links.length}`,
  ];
  for (const row of links) {
    const flag = row.emptied ? "  <-- LEAVES THIS CUSTOMER WITH NO TARGET AT ALL" : "";
    lines.push(
      `${row.customer ?? "?"} -> ${row.venue ?? "?"} (${row.code ?? "no code"}), `
      + `captured by ${row.venue_owner ?? "nobody"}${flag}`,
    );
  }
  for (const row of targets) {
    lines.push(
      `request ${row.request_code ?? "?"} (${row.status ?? "?"}) targets `
      + `${row.venue ?? "?"} (${row.code ?? "no code"})`,
    );
  }
  lines.push("Each of these disappears from the request form's target picker, silently.");
  return lines;
}

/**
 * The refusal, or `null` when the run may proceed.
 *
 * Keyed on `emptied` alone. A customer named twice (two of its links hit by one run) is named once
 * in the message, because the operator needs the count of PEOPLE stuck, not of rows.
 */
export function unlinkStrandingRefusal(links: readonly StrandedLink[]): string | null {
  const emptied = links.filter((row) => row.emptied);
  if (emptied.length === 0) return null;

  const names = [...new Set(
    emptied.map((row) => `${row.customer ?? "?"} (${row.venue_owner ?? "?"})`),
  )];

  return `REFUSED: ${emptied.length} validated link(s) would leave ${names.length} customer(s) with `
    + `no selectable target, so whoever owns them could not raise a marketing request at all and `
    + `nothing would tell them why:\n  ${names.join("\n  ")}\n`
    + `Nothing was written. These venues need a valid code before the unlink can be applied — put `
    + `the question back through the workbook rather than guessing one here.`;
}
