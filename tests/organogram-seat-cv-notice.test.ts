import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CV_EMPTY_NOTICE,
  resolveCvNoticeState,
} from "../src/lib/employees/employee-cv-limits.ts";

/**
 * The organogram seat popup's CV slot has FOUR states, and three of them are silence.
 *
 * WHY THIS TEST EXISTS. The CV download shipped on 2026-09-29 (#4743) gated on one boolean: show
 * the button when the probe came back with a file, otherwise show nothing. On production that
 * meant NOTHING on 189 of 198 seats — only 9 people carry a CV on their master record — so the
 * owner opened seat after seat, saw a header identical to one with no such feature, and reasonably
 * reported the feature as missing. His ruling the same day: "show a greyed No CV on file on seats
 * with no CV".
 *
 * THE DEFECT THE BOOLEAN HID IS THE ONE THIS FILE GUARDS. Once a notice exists, "there is no CV on
 * file" becomes a CLAIM ABOUT AN EMPLOYEE'S RECORD that the popup puts on screen — and a 500, an
 * offline browser or an aborted fetch is not evidence for that claim. The obvious-looking
 * simplification, `setCvState(payload?.cv ? "ready" : "empty")` reached on every response, would
 * tell an SFE that a CV is missing every time the route hiccups, which is worse than the silence it
 * replaced: the first version merely under-informed, that one misinforms. Only a 200 may say
 * "empty". A 401/403 is the CV gate refusing this viewer and is silent too — he is not missing a
 * file, and a notice about a door shut to him either way is noise.
 *
 * THE MARKUP HALF IS ASSERTED ON SOURCE, deliberately and as the narrow exception: nothing in this
 * suite renders React (no test imports react-dom/server), so the three claims that can only be
 * made about the JSX — the wording is the shared constant, the notice is inert, and it carries no
 * radius — are read off the component text. The BEHAVIOUR half is a real call into the real
 * resolver, which is why the decision was moved out of the effect and into employee-cv-limits.ts.
 */

const MODAL_PATH = "src/components/organogram/organogram-node-detail-modal.tsx";

/**
 * The JSX of one `{cond ? ( … ) : null}` branch, from its condition to its own `) : null}`.
 *
 * Anchored on the condition text and ended at the first `) : null}` after it, rather than a fixed
 * byte window: a source-pinning test that slices by offset false-FAILS the moment anything above it
 * shifts by a line, which is a whole category of wasted CI runs in this repo. The slice is asserted
 * to be a plausible size, so a marker that stops matching fails loudly here instead of quietly
 * turning every assertion below it into a test of the empty string.
 */
function sliceBranch(source: string, condition: string): string {
  const start = source.indexOf(condition);
  assert.notEqual(start, -1, `${MODAL_PATH} no longer contains the branch \`${condition}\``);
  const end = source.indexOf(") : null}", start);
  assert.notEqual(end, -1, `the \`${condition}\` branch is no longer a \`? ( … ) : null\` ternary`);
  const branch = source.slice(start, end);
  assert.ok(
    branch.length > 80 && branch.length < 2_000,
    `the \`${condition}\` branch sliced to ${branch.length} characters, which is not a believable ` +
      "size for it — the anchors have drifted and every assertion on this slice would be vacuous",
  );
  return branch;
}

export function runOrganogramSeatCvNoticeTests() {
  // ── 1. THE WORDING IS THE OWNER'S, VERBATIM ───────────────────────────────────────────────
  assert.equal(
    CV_EMPTY_NOTICE,
    "No CV on file",
    "the greyed notice is the owner's own wording (2026-09-29) — reword it and his decision is gone",
  );

  // ── 2. ONLY A 200 MAY CLAIM THE RECORD IS EMPTY ───────────────────────────────────────────
  assert.equal(
    resolveCvNoticeState({ hasCv: false, ok: true, status: 200 }),
    "empty",
    "a 200 saying there is no file IS the empty record — this is the state the owner asked to see",
  );
  assert.equal(
    resolveCvNoticeState({ hasCv: true, ok: true, status: 200 }),
    "ready",
    "a 200 carrying a file must offer the download",
  );

  for (const status of [401, 403]) {
    assert.equal(
      resolveCvNoticeState({ hasCv: false, ok: false, status }),
      "forbidden",
      `${status} is the CV gate refusing this viewer, not an empty record — he is told nothing`,
    );
  }

  // The headline assertion. Every one of these is a response that says NOTHING about whether a CV
  // exists, and not one of them may render "No CV on file".
  for (const status of [0, 404, 429, 500, 502, 503]) {
    assert.equal(
      resolveCvNoticeState({ hasCv: false, ok: false, status }),
      "probing",
      `a ${status} is the absence of an answer, not evidence the record is empty — it must stay ` +
        `silent, or a route hiccup tells an SFE a CV is missing when it is on file`,
    );
  }

  // A fault that still somehow carried a payload must not be promoted to a download either: the
  // response was not ok, so nothing it said is trusted.
  assert.equal(
    resolveCvNoticeState({ hasCv: true, ok: false, status: 500 }),
    "probing",
    "a non-ok response is never a download, whatever its body claimed",
  );

  // ── 3. THE JSX USES THE CONSTANT, NOT A SECOND COPY OF THE SENTENCE ───────────────────────
  const modal = readFileSync(new URL(`../${MODAL_PATH}`, import.meta.url), "utf8");

  assert.ok(
    modal.includes("{CV_EMPTY_NOTICE}"),
    `${MODAL_PATH} must render the shared CV_EMPTY_NOTICE constant, so the wording the owner chose ` +
      "and the wording on screen cannot drift",
  );
  assert.ok(
    !/>\s*No CV on file/.test(modal),
    `${MODAL_PATH} must not hard-code the sentence beside the constant — a second copy is how a ` +
      "reworded notice half-lands",
  );

  // ── 4. THE NOTICE IS INERT, AND THE DOWNLOAD IS NOT ───────────────────────────────────────
  // The empty state is a <span>: there is nothing to fetch, and a disabled-looking <a>/<button>
  // invites the click that a plain sentence does not.
  const emptyBranch = sliceBranch(modal, 'cvState === "empty"');
  assert.ok(
    emptyBranch.includes("<span"),
    "the No CV on file notice must be a <span> — nothing about it is clickable",
  );
  assert.ok(
    !/<a\b|<button\b|href=|onClick=/.test(emptyBranch),
    "the No CV on file notice must carry no link, button, href or click handler: a dead control is " +
      "worse than a sentence, because it looks like the download that is missing",
  );

  const readyBranch = sliceBranch(modal, 'cvState === "ready"');
  assert.ok(
    /href=\{employeeCvHref\(row\.hrId\)\}/.test(readyBranch) && /\bdownload\b/.test(readyBranch),
    "the ready state must still be a real download off employeeCvHref — the notice is an addition, " +
      "never a replacement for the button the owner asked for first",
  );

  // ── 5. SQUARE EDGES, BECAUSE THIS MODAL PORTALS TO THE BODY ───────────────────────────────
  // The shell sweeps that square rounded corners are scoped to .admin-shell and
  // .employee-portal-shell; a portal mounts outside both, so a rounded-* class here renders
  // genuinely rounded and breaks the square-edge golden rule. That is exactly what #4743 had to
  // fix once already on the CV button, which is why it is asserted rather than remembered.
  for (const [label, branch] of [
    ["the No CV on file notice", emptyBranch],
    ["the CV download", readyBranch],
  ] as const) {
    // The CLASS LISTS only, never the branch text: both branches carry a comment explaining why a
    // `rounded-*` would really round here, and a naive scan of the whole slice matches that
    // explanation and fails on the very words that keep the rule. Asserting on the classNames is
    // also the only form of this check that means anything — a class is what the browser reads.
    const classLists = [...branch.matchAll(/className="([^"]*)"/g)].map((m) => m[1] ?? "");
    assert.ok(
      classLists.length > 0,
      `${label} must carry a className for the square-edge check to have anything to read`,
    );
    for (const classList of classLists) {
      assert.ok(
        !/\brounded-/.test(classList),
        `${label} must carry no rounded-* class (found "${classList}"): this modal portals to ` +
          "document.body, outside both shell sweeps, so the corner would really be round " +
          "(THE SQUARE-EDGE GOLDEN RULE)",
      );
    }
  }

  // ── 6. THE CONTROL CLUSTER CAN ACTUALLY WRAP ──────────────────────────────────────────────
  // "No CV on file" is several times wider than "PDF", and at 375px the header cannot hold both
  // on one row. A shrink-0 parent makes an inner flex-wrap INERT — it never shrinks below
  // max-content, so nothing ever needs to wrap and the person's own name gets squeezed instead.
  // THE FITS-THE-SCREEN GOLDEN RULE: fit by wrapping, never a horizontal scroll.
  const cluster = /<div className="flex min-w-0 flex-wrap items-center justify-end gap-1">/.exec(
    modal,
  );
  assert.ok(
    cluster,
    "the header's download cluster must be a shrinkable flex-wrap row (min-w-0, no shrink-0), or " +
      "No CV on file cannot wrap and the header overflows at 375px",
  );
  const clusterParent = modal.slice(Math.max(0, (cluster?.index ?? 0) - 400), cluster?.index ?? 0);
  const parentDiv = /<div className="([^"]*)">\s*$/.exec(clusterParent);
  assert.ok(
    parentDiv && !parentDiv[1]?.includes("shrink-0"),
    "the cluster's own parent must NOT be shrink-0 — that is what makes the inner flex-wrap inert",
  );

  // ── 7. A VIEWER THE SERVER ALREADY KNOWS CANNOT READ A CV NEVER SENDS THE PROBE ──────────
  // 31 Oct 2026 System Audit digest: a Training Manager's every person popup sent the ?meta=1
  // probe, the CV route refused it, and 18 refusals landed on the audit board for a popup that
  // showed nothing either way. The page asks canDownloadEmployeeCv once and threads the answer
  // down; the popup starts at "forbidden" and its probe effect returns before any fetch.
  const probeAt = modal.indexOf("fetch(`${employeeCvHref(row.hrId)}?meta=1`");
  assert.notEqual(probeAt, -1, "the CV probe is still in the popup");
  const probeEffect = modal.slice(modal.lastIndexOf("React.useEffect(", probeAt), probeAt);
  assert.ok(
    probeEffect.includes("if (isVacancy || !canReadEmployeeCv) return;"),
    "the CV probe must return before its fetch when the page said this viewer cannot read a CV",
  );
  // Only the CV probe: the person's own details load for every viewer who may open the chart. The
  // guard landed on the wrong effect once while this was written, and that popup was blank.
  const detailAt = modal.indexOf("/api/reports/organogram/employee/${encodeURIComponent(row.hrId)}`");
  assert.notEqual(detailAt, -1, "the person-details fetch is still in the popup");
  const detailEffect = modal.slice(modal.lastIndexOf("React.useEffect(", detailAt), detailAt);
  assert.ok(
    detailEffect.includes("if (isVacancy) return;") && !detailEffect.includes("canReadEmployeeCv"),
    "the person's details must still load for a viewer who cannot read a CV — only the CV probe is skipped",
  );
  assert.ok(
    modal.includes('React.useState<CvNoticeState>(canReadEmployeeCv ? "probing" : "forbidden")'),
    "and the slot starts at \"forbidden\" for that viewer — silent, never \"No CV on file\"",
  );
  const chart = readFileSync(new URL("../src/components/organogram/org-chart.tsx", import.meta.url), "utf8");
  assert.ok(
    /<OrganogramNodeDetailModal[^>]*canReadEmployeeCv={canReadEmployeeCv}/.test(chart),
    "the chart hands the page's answer to the popup",
  );
  for (const [screen, path] of [
    ["the portal organogram", "src/components/employee-portal/employee-organogram-dashboard.tsx"],
    ["the admin organogram", "src/components/reports/organogram-report.tsx"],
  ] as const) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(
      /<OrgChartTree[^>]*canReadEmployeeCv={canReadEmployeeCv}/.test(source),
      `${screen} hands the page's answer to the chart`,
    );
  }
  for (const path of [
    "app/employee-portals/organogram/page.tsx",
    "app/(admin)/organogram/page.tsx",
    "src/components/workspace/admin-shell-employee-pages.tsx",
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(
      source.includes("canReadEmployeeCv={canDownloadEmployeeCv(access)}"),
      `${path} must decide the CV answer on the server with the CV route's own predicate`,
    );
  }
}
