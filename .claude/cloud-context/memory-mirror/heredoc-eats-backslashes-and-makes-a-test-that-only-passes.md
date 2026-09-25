---
name: heredoc-eats-backslashes-and-makes-a-test-that-only-passes
description: "Writing a .ts/.mjs file with `cat > f <<'EOF'` via the Bash tool eats one backslash from `\\\\b` / `\\\\.` / `\\\\s`, in BOTH template and plain string literals, so the built regex matches the wrong thing and the check silently passes."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 017d8079-a3de-457a-8fe5-0bd4b88a5373
  modified: 2026-09-04T20:15:16.938Z
---

Writing TypeScript through the Bash tool with a **quoted heredoc** (`cat > file <<'EOF' ... EOF`)
still lost a backslash: `new RegExp(\`\\b${name}\\b\`)` landed on disk as `new RegExp(\`\b${name}\b\`)`.
A quoted heredoc is supposed to be literal, so this is not the documented shell behaviour — verify
the bytes, do not trust the quoting.

The damage is that it **fails silently in the passing direction**. In a template literal `\b` is
U+0008 BACKSPACE, not a word boundary, so the regex became `\x08NAME\x08` and matched nothing. Every
`assert.ok(regex.test(...))` built that way is then a test that can only ever pass. Caught 2026-08-21
in `tests/recruitment-reread-model-constants.test.ts` only because the assertion was exercised
against known-good code first and went RED — the wrong direction — which is the tell.

**It is NOT limited to template literals** — this file said so until 2026-08-25 and that was wrong,
which is what made a plain string look like the safe workaround. Confirmed twice that night while
building `src/lib/recruitment/employer-name.ts`:

| written in the heredoc | landed on disk | what it then did |
| --- | --- | --- |
| `` `…replace(/\\.$/, "")…` `` (template) | `/.$/` | `.` matches ANY char, so it stripped the last character of every value |
| `"const X = /\\s+\\.\\s*$/;"` (plain `"…"`) | `/\s+\.\s*$/` → `s+.s*$` | the string never matched its target, so the edit silently did nothing |

The second one is the more dangerous shape: it was a break-test mutation, and a mutation that fails
to apply reads as "the rule is untested" only if the harness checks. Mine did (`if (mutated ===
PRISTINE) …MUTATION DID NOT APPLY`) — without that guard it would have looked like a passing test.

**Why:** this repo is full of source-inspecting tests (`readFileSync` + regex over
`scripts/*.ts` and `src/lib/**`), and they are exactly the tests that build regexes by
interpolation. A vacuous one is indistinguishable from a real one in CI output forever.

**How to apply:**
- **When a file needs ANY backslash, write it with the Write tool, not a heredoc.** No exception for
  plain strings, and no exception for `<<'QUOTED'`.
- Prefer code that needs no backslash at all: `value.endsWith(".") ? value.slice(0, -1) : value`
  instead of `replace(/\.$/, "")`; `new Set(fragment.split(/[^\w$]+/).filter(Boolean)).has(name)`
  instead of a built `\\b…\\b` regex. Static regex literals in a heredoc survive fine.
- Give every break-test harness a **mutation-applied guard** — compare the mutated source to the
  pristine one and print `MUTATION DID NOT APPLY` rather than running the test. That is what turned
  a silent hole into a visible line tonight.
- Always run a new assertion against **known-good** code first and confirm it is GREEN, then break
  the fix and confirm RED. Only checking the red direction cannot distinguish a working assertion
  from one that fires for an unrelated reason; only checking green cannot see a vacuous one.
- `cat -A` on the written file shows the real bytes when a check behaves impossibly.

Related: [[prove-it-fails-verify-which-assertion-fired]] · [[add-test]] ·
[[shell-grep-unusable-use-git-grep-or-rg]]

## 2026-08-26 — a QUOTED heredoc still collapses doubled backslashes. Use forward slashes in Windows paths.

The assumption that `<<'EOF'` (quoted) is safe because it suppresses expansion is **wrong for
backslashes**. Measured this date writing a Node script through `cat > file <<'EOF'`:

- `"C:\Users\satoh\..."` written -> `"C:\Users\satoh\..."` on disk. **Doubles collapsed to singles.**
- `/\]\(/`, `/\u{1F534}/gu`, `\u00a7` written with SINGLE backslashes -> preserved exactly.

So the rule is narrower and more useful than "a heredoc eats backslashes": it eats **one level**.
Anything already single survives; anything doubled for a JS string literal arrives halved. That is
why the regexes and unicode escapes in the same file were fine while only the three path constants
broke — and why the failure looked like a Node bug rather than a shell one. The error is an ENOENT on
a path with every separator gone (`C:Userssatoh.claude...`), because JS then reads `\U` `\s` `\.` as
escape sequences and drops the backslash a second time.

**Fix: write Windows paths with forward slashes** — `"C:/Users/satoh/..."`. Node accepts them on
Windows, and they need no escaping at either layer, so the heredoc has nothing to eat. Cheaper than
quadrupling backslashes and far cheaper than debugging it. If a script genuinely needs backslashes in
its source, do not use a heredoc at all — write it with the Write tool.

Check before running, not after: `sed -n '1,8p' <script>` and confirm the paths still have their
separators. `node --check` will NOT catch this — the mangled string is still valid syntax.

## 2026-09-04 — how to SWEEP the repo for the residue. There is a second on-disk shape.

A repo-wide audit this date found the damage lands in **two different on-disk shapes**, and only one
of them is greppable as text:

1. **A literal `0x08` byte in the source.** The `\b` was interpreted, not halved, so the file holds a
   real BACKSPACE character. Byte-exact and cheap to sweep across every tracked file:
   `git ls-files -z | xargs -0 grep -lP '[\x07\x08\x0b\x0c\x1b]'`. Anything it names that is not a
   binary blob is damage. This is the shape a `cat -A` reveals as `^H`.
2. **A halved escape that is still valid JS** — `"\b"` / `` `\b` `` inside a STRING literal. The file
   looks perfect in a diff and in review; the backspace only exists at runtime. Grep cannot separate
   it from correct code by eye, so compare against the repo's own correct form: a regex built from a
   string needs `"\\b"`, and `tests/access-registry-coverage.test.ts` has the right shape to diff
   against. `String.raw` is the other correct form and is a FALSE positive.

**Both shapes fail in the passing direction, and both survived in NEGATIVE assertions** — an
`assert.doesNotMatch` or a `!regex.test(...)` whose pattern can never match is a permanent green.
That is why they outlive review: a positive assertion built this way goes red immediately and gets
fixed, so **the residue that accumulates is nearly all negative assertions.** Audit those first.

**A registered sweep now exists — extend it, never hand-roll a second one.**
`tests/heredoc-backslash-damage.test.ts` checks both shapes across `app`, `src`, `tests`, `scripts`,
`supabase` and `.claude/hooks` and runs in the required CI `validate` job (PR #3100). It skips
`String.raw` and is line-scoped, so a `new RegExp(` whose pattern sits on the FOLLOWING line is
deliberately out of reach — widening that window costs false positives on the many legitimate
`x.replace(/\s+/g, " ")` calls that share a line with a constructor.

**Prove it in BOTH directions with a positive control.** Run the on-disk pattern and the intended
pattern against one input that genuinely violates the rule; a real check fires on the intended
pattern and not the on-disk one. Do NOT build that comparison through `node -e` in a shell — the
shell eats the escape a second time and reports the CORRECT pattern as also not firing, which reads
as "the test was fine". Write the verifier to a file with the Write tool.
