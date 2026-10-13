import assert from "node:assert/strict";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";

/**
 * A class error boundary that catches a stale-deploy chunk failure must RECOVER from it, not merely
 * report it.
 *
 * ## What happened
 *
 * A deploy replaces the build's JS chunk files. A tab that was already open then asks for a chunk
 * URL that no longer exists on the server, and `next/dynamic` throws
 * `Failed to load chunk /_next/static/chunks/<hash>.js from module <id>` inside its own Suspense.
 * `src/lib/utils/stale-deploy-recovery.ts` has recognised that shape since 2026-09-08 and a reload
 * clears it, because the reload re-reads the CURRENT manifest.
 *
 * Every path that sees such an error called that recovery — window.onerror and unhandledrejection
 * (GlobalErrorReporter), the root boundary (ReportingErrorBoundary), and each route `error.tsx` —
 * with ONE exception: `WorkspaceErrorBoundary`, which is the boundary
 * `EmployeePortalPageShell` wraps every employee-portal page in. So it, and not any route
 * boundary, is what catches a lazy-chunk failure anywhere in the portal, Phoenix CRM included. It
 * reported the error and then rendered a card whose only control called
 * `this.setState({ hasError: false })` — which re-renders the same `Lazy` and re-requests the same
 * deleted file. The section stayed broken until the user knew to hard-refresh.
 *
 * Production recorded exactly that, and the tell is `sinceNavMs` still CLIMBING across repeated
 * failures in one document — proof that no reload ever happened:
 *
 *   2026-09-21 13:10:13/14/23  /employee-portals/weekly-sales   seq=2,3,4  sinceNavMs 585408 → 595070
 *   2026-10-13 15:04           /employee-portals/field-crm/visits  a rep's handset, component stack
 *                                                                  `Lazy → Suspense → LoadableComponent`
 *
 * The same shape arriving through window.onerror instead (e.g. /admin/field-crm, 2026-10-13 14:21)
 * was recovering the whole time, which is why the portal rows read as an unlucky few rather than as
 * the one code path with no recovery in it.
 *
 * ## What is pinned
 *
 * A CENSUS, not a list of two files: every `componentDidCatch` under `app/` and `src/` must reach
 * the detector and the recovery. A new boundary written next year inherits the rule instead of
 * re-learning it. The census count is asserted non-zero first, because a sweep that reads nothing
 * reports a clean tree (AGENTS.md §2.1).
 *
 * Comments are stripped first: this prose names every identifier it asserts on, so a test reading
 * raw source would be satisfied by its own explanation and would stay green if the calls were
 * deleted (AGENTS.md §2.1, "a source assertion is satisfied by the comment that explains the call").
 */

const ROOTS = ["app", "src"] as const;
const DETECTOR = "isStaleDeployChunkError";
const ROUTER_DETECTOR = "isTransientRouterMountError";
const RECOVERY = "recoverFromStaleDeployOnce";

const WORKSPACE_BOUNDARY = "src/components/ui/workspace-error-boundary.tsx";
const CHART_BOUNDARY = "src/components/sales/sales-performance-page.tsx";
const ROOT_BOUNDARY = "src/components/layout/reporting-error-boundary.tsx";

function* tsxFilesUnder(directory: string): Generator<string> {
  for (const name of cachedReaddir(directory)) {
    const full = path.join(directory, name);
    if (cachedIsDirectory(full)) {
      yield* tsxFilesUnder(full);
    } else if (name.endsWith(".tsx")) {
      yield full;
    }
  }
}

/** Repo-relative, forward-slashed, so an assertion message is the path a reader can open. */
function repoPath(file: string): string {
  return file.split(path.sep).join("/");
}

export function runErrorBoundaryStaleDeployRecoveryTests() {
  // ── The census: every class error boundary in the app ──────────────────────
  const boundaries = new Map<string, string>();
  for (const root of ROOTS) {
    for (const file of tsxFilesUnder(root)) {
      const code = stripComments(cachedReadFile(file));
      if (code.includes("componentDidCatch(")) boundaries.set(repoPath(file), code);
    }
  }

  // A sweep that found nothing would pass every assertion below it.
  assert.ok(
    boundaries.size >= 3,
    `the componentDidCatch census must find the app's error boundaries — it found ${boundaries.size} under ${ROOTS.join(", ")}, so the sweep itself is broken, not the tree`,
  );
  for (const expected of [WORKSPACE_BOUNDARY, CHART_BOUNDARY, ROOT_BOUNDARY]) {
    assert.ok(
      boundaries.has(expected),
      `the census must reach ${expected} — it is a class error boundary, and a census that misses one cannot pin it`,
    );
  }

  // ── Every one of them recovers, not just reports ───────────────────────────
  for (const [file, code] of boundaries) {
    assert.ok(
      code.includes(`${RECOVERY}(`),
      `${file}: a class error boundary must call ${RECOVERY}() on a stale-deploy chunk error — the deploy deleted the chunk, so clearing hasError re-requests a file that is gone and the section stays broken (production: /employee-portals/field-crm/visits, 2026-10-13)`,
    );
    assert.ok(
      code.includes(`${DETECTOR}(`),
      `${file}: a class error boundary must ask ${DETECTOR}() before recovering, so an ordinary application error still shows its own fallback instead of silently reloading the page`,
    );
  }

  // ── The portal shell's boundary: the fix that closed the hole ──────────────
  const workspace = boundaries.get(WORKSPACE_BOUNDARY) ?? "";

  // Decided in getDerivedStateFromError, so render() can offer the one control that helps. Both
  // detectors, because a transient router-mount error clears on a reload and on nothing else.
  assert.match(
    workspace,
    new RegExp(`staleDeploy:\\s*${DETECTOR}\\(error\\)\\s*\\|\\|\\s*${ROUTER_DETECTOR}\\(error\\)`),
    `${WORKSPACE_BOUNDARY}: getDerivedStateFromError must record whether this was a stale deploy, or render() cannot tell a missing chunk from a real application error`,
  );

  assert.ok(
    workspace.includes("window.location.reload()"),
    `${WORKSPACE_BOUNDARY}: the stale-deploy fallback's control must reload the page — a setState that clears hasError asks for the same deleted chunk again, which is the defect this boundary shipped with`,
  );

  // The stale-deploy branch must be the FIRST thing render() answers. Behind the generic
  // `hasError` card it is dead code, and the generic card's only control is the state reset.
  const staleBranch = workspace.indexOf("if (this.state.staleDeploy)");
  const genericBranch = workspace.indexOf("if (this.state.hasError)");
  assert.ok(
    staleBranch !== -1,
    `${WORKSPACE_BOUNDARY}: render() must answer the stale-deploy case explicitly`,
  );
  assert.ok(
    genericBranch !== -1,
    `${WORKSPACE_BOUNDARY}: render() must keep its generic error card for every other failure`,
  );
  assert.ok(
    staleBranch < genericBranch,
    `${WORKSPACE_BOUNDARY}: the stale-deploy branch must come BEFORE the generic hasError card — behind it, it never renders and the user is left with the "Try Again" that cannot work`,
  );

  // ── The sales dashboard's chart boundary: same mechanism, same answer ──────
  const chart = boundaries.get(CHART_BOUNDARY) ?? "";
  assert.match(
    chart,
    new RegExp(`staleDeploy:\\s*${DETECTOR}\\(error\\)\\s*\\|\\|\\s*${ROUTER_DETECTOR}\\(error\\)`),
    `${CHART_BOUNDARY}: Recharts arrives through next/dynamic, so the chart's own chunk 404s after a deploy — the boundary must record it`,
  );
  assert.ok(
    chart.includes("window.location.reload()"),
    `${CHART_BOUNDARY}: the chart's stale-deploy control must reload, not re-render the same missing chunk`,
  );
}
