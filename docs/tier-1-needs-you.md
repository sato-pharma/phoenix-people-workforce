# The tier-1 board — what is waiting on the owner, with no model

```bash
node scripts/needs-you.mjs
```

`pnpm run needs-you` from the primary checkout; **never `pnpm` inside a worktree** (AGENTS.md §5 —
`bash-guard.mjs` C6 denies it), so invoke node directly there.

| Flag | What it does |
| --- | --- |
| *(none)* | The board |
| `--fresh` | Ignore the cache and re-read everything |
| `--json` | The same facts as JSON |
| `--quiet` | One line: how many things need him |

## Why it exists

Merging is the one action this repository never takes on the owner's behalf (AGENTS.md §6:
*"PROTECTED ACTIONS — merging any branch or Pull Request into `main`"*). So at any moment some
number of PRs sit green, waiting on a click only he makes.

Before this, the only way to learn that number was to open a Claude session and ask — which spends a
model call, a session slot and a minute of his attention on a question that is pure lookup. He runs
about a dozen sessions at once and has said plainly that the count of them is what overwhelms him
(AGENTS.md §0). A question whose answer is already sitting in GitHub should not cost a session.

The idea is lifted from a demo of a personal "agentic OS" the owner sent on 2026-09-28, which sorted
every request into three tiers by *the cost of the answer*: rules and saved data with no AI, then a
small fast model, then a full agent. Phoenix already lives entirely at tier 3 — every question spins
up a session. **This is tier 1, and only tier 1.** It never asks a model anything, it never writes,
and it never merges.

## What it measures, and what that cost

Measured 2026-09-28 against the live repository:

| | |
| --- | --- |
| Cold (four parallel network reads) | **2.7 s** |
| Warm (cache hit) | **0.097 s** |

The cache is machine-wide (`<tmp>/phoenix-needs-you.json`, 60-second TTL) rather than per-worktree
**on purpose**: every fact here is global — open PRs, branch protection, what production is serving
— so a dozen sessions asking the same question should get one answer, not twelve. A cached answer is
always labelled with its age in Cairo time and can never be mistaken for a live read.

## The rule that shapes every line of it

🔴 **A board that under-reports is worse than no board.** If it prints *"Nothing is waiting on a
decision only you can make"* while a PR sits green — or while it simply failed to reach GitHub — it
has cost him the merge more surely than no board would have, because he has delegated the looking.

So every unknown is printed loudly in its own `COULD NOT READ` section and is **never** collapsed
into the clean answer. That is the `?? null` discipline `scripts/repo-doctor.mjs` documents in four
places and `scripts/branch-pr-state.mjs` states outright: *git and gh both answer null when the
command FAILED, and collapsing that into the clean answer renders a check that never ran as a check
that passed.*

Over-reporting is allowed and deliberately untested. A row he glances at and dismisses costs him two
seconds; a row that never appeared costs him a deploy.

## Why GitHub's own verdict decides, and protection only explains

The bucket comes from `mergeStateStatus` — the gate's own answer to *"may this merge"*. This file
does **not** recompute that by counting passing checks against a list, because counting to a number
is the exact failure AGENTS.md §2 records: the required-check list has rotted four times
(4 → 5 → 6 → 4, the last on 2026-09-27 when #4527 folded `lint`+`typecheck`+`test` into one `checks`
job), and after every rename the repository went on stating the old one. A session that counts to a
number a doc gave it waits forever for checks that no longer exist.

The live protection contexts *are* read, through `scripts/required-check-names.mjs` — the one live
read of branch protection in this repository, reused rather than re-implemented. But they only
supply the **words** that explain a blocked PR. They never overrule the gate, and when they cannot
be read the explanation degrades to "blocked" while the verdict is untouched, because the verdict
never depended on them.

A required check absent from the rollup entirely is named as *"(no report yet)"* rather than
dropped. That is the `mobile` shape — it runs only when `mobile/` changed, so absence is a routine
state, and silently ignoring it would be the under-report direction again.

## The three sections

| Section | What lands there |
| --- | --- |
| **NEEDS YOU** | Green on every required check. Printed as `merge <n>` — the exact words he would type. |
| **CLAUDE'S WORK, NOT YOURS** | Red, conflicted, draft, or waiting on CI. Named so he does *not* act on it. |
| **WORTH KNOWING** | What production is serving, and how far behind `main` it is. |
| **COULD NOT READ** | Every unknown, with the reason in words. |

The production line names a redeploy and a re-merge as **forbidden**, because AGENTS.md §2.3 records
that the next green merge carries a withheld deploy forward by itself — a board that hinted at
either would walk him into the one remedy the rule forbids. `tests/needs-you-board.test.ts` pins
that sentence.

## What it deliberately does not do

- **It does not decide worktree retirement.** That question already has an owner —
  `scripts/branch-pr-state.mjs` for the branch half, `scripts/worktree-liveness.mjs` for the
  live-process half — and the live half needs a PowerShell PEB sweep, which is seconds, not
  milliseconds. A second copy of a rule whose wrong answer deletes a folder is precisely what
  `branch-pr-state.mjs` exists to prevent. Run `node scripts/repo-doctor.mjs` for that.
- **It does not read Supabase.** Business state — an unpublished month, a pending approval — is a
  different tier: it needs credentials, it is slow, and getting it wrong misreports money.
- **It does not merge, push, comment, or write** anything except its own cache.
- **It never exits non-zero on its findings.** This is a status board, never a gate — an exit code
  would sooner or later be wired into something that blocks, and then a network blip would block it.

## Where it is pinned

`tests/needs-you-board.test.ts`, registered in `tests/run-tests.ts` and therefore a step of the
required `checks` job. It drives the real exported functions, not a restatement of them. The
under-report guard was proven by breaking it: forcing the unmodelled-state branch to return `yours`
made the first assertion fire with its own message before the file was restored from a copy.
