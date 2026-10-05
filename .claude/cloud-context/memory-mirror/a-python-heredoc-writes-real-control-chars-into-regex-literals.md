---
name: a-python-heredoc-writes-real-control-chars-into-regex-literals
description: "editing a source file with a `python - <<'PY'` heredoc and a NON-raw string turns every \\b \\n \\f \\v inside a regex literal into a real control character, so the written regex can never match and the failure reads as 'my regex is wrong' — python's own SyntaxWarning is the only warning you get, and it names the line it is on, not the file it corrupts"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d96338c4-b2ab-41ed-aa4e-ed85e9af64ce
  modified: 2026-10-05T09:57:20.800Z
---

Cost three full `remote-check` rounds on 2026-10-05 (about 20 minutes of box time each) while
editing `tests/phoenix-crm-*.test.ts`.

**What happens.** In `python - <<'PY'` the heredoc is literal, but the python STRING inside is not:
`'...\\b recordRefusedReading \\b...'` written as `"\brecordRefusedReading\b"` puts byte `0x08`
either side of the token. The file then contains a regex that cannot match anything. The same bites
`\n` (a real newline, which also breaks the regex literal across two lines → `TS1128: Declaration or
statement expected` or `Unterminated regexp literal`), `\f` and `\v`.

**Why it is so expensive.** The corruption is INVISIBLE to every normal read:
`sed -n '226,236p'` prints the line looking correct (the terminal eats the backspace, or renders the
preceding character over itself), `grep` finds the token, and `git diff` shows nothing odd. So the
assertion failing reads as *the thing I asserted is not true* — which sends you to re-check the
production code that is in fact perfectly correct.

**The three habits that stop it:**

1. **Use a raw string for anything with a backslash** — `good=r'...\b...\n...'`. Python prints
   `SyntaxWarning: invalid escape sequence '\b'` when you forget, and that warning is the ONLY
   signal; treat it as an error, never as noise.
2. **Dump the bytes, not the glyphs**, before believing a line is right:
   `node -e 'readFileSync(f,"utf8").split(/\r?\n/).forEach((l,i)=>...JSON.stringify(l))'` — a
   `\b` shows up as `\b` in `JSON.stringify` and as nothing at all in `sed`/`cat`.
3. **Sweep every file you wrote** before committing:
   `if (/[\x00\x08\x0b\x0c]/.test(src))` over `git ls-files -m -o --exclude-standard`. It is two
   seconds and it is the only check that is not fooled.

And run the affected test FUNCTION locally first (`import { runXTests } from "./tests/x.test.ts"`
under `--experimental-strip-types` with the alias loader) — it is free, it needs no typecheck, and it
would have caught all three rounds. It does NOT replace `remote-check`
([[a-green-test-run-carries-no-type-signal-at-all]]), it just stops you paying for a typo.
