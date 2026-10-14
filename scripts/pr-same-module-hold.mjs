// Is there already a PR in this PR's module — open now, or merged in the last few hours?
//
// WHY THIS EXISTS. Every merge to `main` costs two full CI runs whatever its size (the PR's and the
// push's, which is also the production deploy gate), and the owner pays for both. On 13 Oct 2026 the
// repo merged 55 times in a day and the 62 PR branches that day took 122 CI runs. Roll-ups do not
// recover that cost — the roll-up PR pays its own CI run — so the lever is upstream: fewer PRs, with
// related changes to one module committed onto ONE branch instead of opened as a stream of narrow
// ones. AGENTS.md has asked for that ("ONE WIDE PR") since 2026-09-27 and the prose did not hold, so
// `bash-guard.mjs` clause C18 calls this before every `gh pr create` (owner, 2026-10-14, cost cuts:
// "same-module hold: guard on gh pr create").
//
// THE MODULE IS THE CONVENTIONAL-COMMIT SCOPE of the PR title, `type(scope): subject`. The repo's
// titles all wear it, so nothing extra has to be marked and there is no second registry to drift.
//
// FAILS OPEN in every direction: a title with no scope, a scope that is dependency or memory
// plumbing, an unreadable `gh` answer — all allow. A hold that blocks a real PR on its own blind
// spot costs more than the runs it saves. `PHX_PR_HOLD_OK=1` stands it down for an urgent fix.

/** Scopes that are plumbing, not a module: the bot's dependency bumps and the memory fold. */
const EXEMPT_SCOPES = new Set(["deps", "deps-dev", "memory", "rollup"]);

/** How long a merged PR keeps its module held. */
export const HOLD_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The conventional-commit scope of a title, lowercased — or `null` when there is none or it is
 * exempt plumbing. `feat(sales-closing-exports): …` → `sales-closing-exports`.
 */
export function prScope(title) {
  const match = /^\s*[a-z]+\(([^)]+)\)!?:/i.exec(String(title ?? ""));
  if (!match) return null;
  const scope = match[1].trim().toLowerCase();
  if (!scope || EXEMPT_SCOPES.has(scope)) return null;
  return scope;
}

/** `fix(a,b)` and `fix(b)` are the same module: they share a token. */
function scopeTokens(scope) {
  return String(scope)
    .toLowerCase()
    .split(/[,/\s]+/)
    .filter(Boolean);
}

function sharesModule(a, b) {
  const right = new Set(scopeTokens(b));
  return scopeTokens(a).some((token) => right.has(token));
}

/**
 * The `--title` of a `gh pr create` command, or `null` when it cannot be read (a title built in a
 * variable or a subshell is not guessed at).
 */
export function prTitleFromCommand(text) {
  const match = /(?:^|\s)(?:--title|-t)(?:\s+|=)(?:"([^"]*)"|'([^']*)'|([^\s"'][^\s]*))/.exec(String(text ?? ""));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The PR that already holds `title`'s module, or `null`.
 *
 * Pure on purpose: listing PRs is an API call, so the caller fetches and this decides — the same
 * split `rollupHolding` uses, which is what lets the decision table be tested without a network.
 *
 * @param {{ title: string | null | undefined,
 *   open?: Array<{ number: number, title?: string | null, headRefName?: string }>,
 *   merged?: Array<{ number: number, title?: string | null, mergedAt?: string | null }>,
 *   now?: number }} args  `title` is the PR about to be opened; `open` and `merged` are what `gh pr list`
 *   returned; `now` is epoch ms, injectable for tests.
 * @returns {{ kind: "open" | "merged", number: number, title: string, mergedAt?: string } | null}
 */
export function holdingPr({ title, open, merged, now = Date.now() }) {
  const scope = prScope(title);
  if (!scope) return null;

  for (const pr of open ?? []) {
    const other = prScope(pr?.title);
    if (other && sharesModule(scope, other)) {
      return { kind: "open", number: Number(pr.number), title: String(pr.title ?? "") };
    }
  }

  for (const pr of merged ?? []) {
    const other = prScope(pr?.title);
    if (!other || !sharesModule(scope, other)) continue;
    const at = Date.parse(pr?.mergedAt ?? "");
    if (!Number.isFinite(at)) continue;
    if (now - at >= 0 && now - at <= HOLD_WINDOW_MS) {
      return { kind: "merged", number: Number(pr.number), title: String(pr.title ?? ""), mergedAt: pr.mergedAt };
    }
  }
  return null;
}

const cairo = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The refusal text: names the PR, says what to do instead, and how to stand the hold down. */
export function holdDenial({ title, holder, standDown }) {
  const scope = prScope(title);
  const head =
    holder.kind === "open"
      ? `PR #${holder.number} ("${holder.title}") is already open for the same module (${scope}).`
      : `PR #${holder.number} ("${holder.title}") for the same module (${scope}) was merged at ` +
        `${cairo.format(new Date(holder.mergedAt))} Cairo, inside the last 6 hours.`;
  const instead =
    holder.kind === "open"
      ? "WIDEN THAT PR: commit this work onto its branch and push — or hold this work until it merges."
      : "HOLD THIS WORK: batch it with the module's next change instead of opening a second PR for the same area.";
  return (
    `C18 — a second PR for one module is refused (owner, 2026-10-14, cost cuts). ${head}\n\n` +
    `${instead}\n\n` +
    "WHY: every merge to `main` costs two full CI runs whatever its size — on 13 Oct 2026 the repo merged " +
    "55 times in a day and 62 PR branches took 122 CI runs. A roll-up does not recover that (the roll-up PR " +
    "pays its own run); fewer PRs does. AGENTS.md §6, ONE WIDE PR.\n\n" +
    "If this one genuinely has to ship alone (an urgent fix, a locked file, a migration needing its own " +
    "approval), run it again as:\n  " +
    standDown
  );
}
