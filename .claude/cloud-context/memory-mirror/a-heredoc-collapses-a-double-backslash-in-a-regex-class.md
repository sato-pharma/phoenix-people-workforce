---
name: a-heredoc-collapses-a-double-backslash-in-a-regex-class
description: "Writing a file with a QUOTED heredoc still collapsed `\\` to `\` here, so a regex class written as [^/\\\n] landed as [^/\\n] — which excludes the LETTER n, not a backslash. The guard test then extracted nothing for any locator containing an n and PASSED while the real break sat in the file; only a count guard (patterns extracted == occurrences in the file) exposes it. Read a regex back off disk and compare `re.source` to what you intended."
metadata:
  node_type: memory
  type: project
---

Writing `tests/login-locator-matches-label.test.ts` with `cat > f <<'EOF'` — a **quoted**
heredoc, which is supposed to be literal — the two sequences `[^/\\n]` and `|\.` arrived on disk
as `[^/\n]` and `|\.`, one backslash short each.

**What that does to the regex is the nasty part.** `[^/\n]` is not "not a backslash and not a
newline". It is **not `/`, not `\`, and not the letter `n`**. So the extraction regex

```
/getByRole\(\s*["']textbox["']\s*,\s*\{\s*name:\s*\/((?:[^/\n]|\.)+)\/([a-z]*)/g
```

could not read any locator whose pattern contained an `n`. The real defect under test was
`/HR_ID or Login ID/i` — **"Login" has an `n`** — so the body stopped at it, the closing `/` never
matched, the locator was not extracted at all, and the test **PASSED with the break applied**. The
working locator `/HR[_ ]?ID/i` has no `n`, which is exactly why the passing case looked fine.

**How it was found.** `litA.source` printed what the engine actually held, next to what was
intended. That one line settles it; reasoning about the data never did — the bytes were plain ASCII
with the `/` right where it belonged, and a step-by-step ladder of partial regexes showed only
"fails at the closing slash", which points at the wrong half.

**How to apply.**

- A guard test that EXTRACTS things must assert it extracted them all:
  `assert.equal(found.length, code.split('getByRole("textbox"').length - 1, …)`. Nothing else
  catches an extraction that silently sees fewer items — the per-item checks pass by not looking.
- **Prefer a pattern that needs no escaped backslash at all.** `[^/\n]+` (one backslash) survives
  every writing path; `[^/\\n]` does not.
- When a regex is the point of the edit, **read it back off disk** and print `re.source`. Same
  family as [[the-edit-tool-resolves-a-unicode-escape-into-the-character]]: the diff you intended
  is not evidence of the bytes on disk.
- Verify a break by reading the file back BEFORE trusting that the test did not fire — a `replace`
  that matched nothing prints success just the same
  ([[a-selftest-probed-with-the-wrong-flag-reads-as-no-selftest]] is the same shape).

See also [[a-backtick-in-a-regex-literal-blinds-a-comment-only-guard]] — the other way a regex
literal silently breaks a comment-aware guard in this repo.
