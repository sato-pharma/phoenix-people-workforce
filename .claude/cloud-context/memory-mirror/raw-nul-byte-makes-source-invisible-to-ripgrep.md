---
name: raw-nul-byte-makes-source-invisible-to-ripgrep
description: "A raw 0x00 in a .ts file makes ripgrep (Grep tool, rg, gg) skip the whole file silently — 4 source files had one; FIXED + MERGED PR #1605 (549635be)"
metadata: 
  node_type: memory
  type: project
  originSessionId: b97ef79e-b43d-4c90-9bd4-88f5626ee922
  modified: 2026-08-13T22:54:18.806Z
---

**RESOLVED — PR #1605 squash-merged as `549635be` on 2026-08-02 00:15 Cairo.** All five
CI checks passed; merged blobs on `main` verified at 0 NUL bytes with all 7 escapes
intact. Production returned HTTP 200 after the merge, but note the Railway deploy of
that specific revision was **not** independently confirmed — the app exposes no
health/version endpoint and the worktree is not `railway link`ed, so there is no way to
read the serving revision from the CLI. Harmless here (the change is byte-identical at
runtime), but worth knowing for any future deploy that does change behavior.

Four TypeScript files contained a **raw NUL byte (0x00)** written directly into a
template literal as a composite-key separator. ripgrep classifies any file containing a
NUL as binary and **skips it entirely**. In a single-file search it says
`binary file matches`; in a **directory search it says nothing at all** — the file is
silently absent from the results.

Measured on 2026-08-01 before the fix: `Grep month_key src/lib/deductions/` reported
"14 occurrences across 2 files". The truth was 3 files — `service.ts` (40 KB, the
module's largest file, 6 real matches) was dropped with no warning. `git grep --text`
was the only tool that could see it.

Files affected (7 NUL bytes total), all fixed by replacing the raw byte with the
six-character Unicode escape (backslash + `u0000`) — the owner chose that over the
short `\0` form specifically to match the convention already in the repo:

- `src/lib/deductions/service.ts` — `pairKey()` batch-dedup separator
- `src/lib/analytics/service.ts` — closing bucket key (period/line/rep), 2 bytes
- `src/lib/sales/monthly-closing-comparison.ts` — `avgRealizedPrice` key
- `src/lib/sales/normalizer/customer-propagate.ts` — chain/branch key, 3 bytes

**The repo already had a correct convention for this**: the six-character escape
`\` `u0000`, used in 15 places across 7 files — e.g. `src/lib/attendance/metrics.ts:76`
builds the identical kind of composite key with it. The four broken files were the
outliers, and all four were converted to match it. That longer escape is also strictly
safer than `\0`: a `\0` followed by a **digit** is a legacy octal escape and a
SyntaxError in strict mode and template literals, so `\0` is only valid when the next
character is not 0-9. **Standing rule: use the six-character escape for a NUL
separator in this repo, never the short form and never a raw byte.**

**Beware writing *about* this bug.** Typing the six-character escape into a tool
argument that goes through a JSON layer decodes it into a real NUL and reintroduces the
defect in the file you are writing — this happened while first saving this very memory
(3 NUL bytes landed in it). Escape the backslash, then byte-scan the result.

**Why:** search results that are silently incomplete are worse than an error. Every
audit, refactor, and impact analysis run against these modules since the bytes landed
was working from a false negative, and nothing indicated it.

**How to apply:** if a search result looks suspiciously empty or short, re-run it with
`git grep --text` before concluding the code isn't there. To find the cause repo-wide,
scan tracked files for a 0x00 byte — only genuine binaries (`.png`, `.jpg`, `.xlsx`,
`.woff2`, `.ico`) should ever have one; as of 2026-08-01 exactly 180 tracked files
contain a NUL and all 180 are real binaries. Never write a raw control character into
source. Related: [[shell-grep-unusable-use-git-grep-or-rg]].

**Recurred 2026-08-14 in a brand-new file** (`src/lib/business-review-s1/canonical.ts`,
written this session for the Rule #1 S1 rebuild) — two sentinel Map keys
(`NO_AREA_KEY`/`NO_DM_KEY`) got a real 0x00 byte instead of the six-char escape,
`git grep`/Grep-tool reported "binary file matches" on the whole file. **The Edit-tool
text channel is inconsistent, not reliably escapable**: typing the six-char escape
inline in prose (a comment, not inside a string literal) silently decoded to a real NUL
in the written file; typing it doubled (`\\u0000`) inside a string-literal old/new_string
landed as a literal *double* backslash + `u0000` instead of reducing to one — neither
guess matched what actually hit disk. **Do not try to out-guess the escaping by typing
backslash variants through Edit/Write.** Fix (and verify) at the byte level instead: a
small Node script (`fs.readFileSync(path)` as a `Buffer`, scan for byte `0`, splice in
`String.fromCharCode(92) + "u0000"` built from char codes, `fs.writeFileSync`), then
re-scan the buffer for byte `0x00` to confirm zero remain — trusting the tool's "file
updated successfully" message is not enough, it doesn't echo bytes.
