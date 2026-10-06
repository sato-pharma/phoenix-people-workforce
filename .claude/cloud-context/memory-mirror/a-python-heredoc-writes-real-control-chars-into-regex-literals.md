---
name: a-python-heredoc-writes-real-control-chars-into-regex-literals
description: "editing a source file with a `python - <<'PY'` heredoc and a NON-raw string turns every \\b \\n \\f \\v inside a regex literal into a real control character, so the written regex can never match and the failure reads as 'my regex is wrong' — python's own SyntaxWarning is the only warning you get, and it names the line it is on, not the file it corrupts. It also collapses a DOUBLED escape you wrote deliberately: a backslash-backslash-u0600 lands as the real character and a doubled backslash-n as a real newline inside a template literal, which is valid JS that reads nothing like what you wrote - so write the replacement text as a RAW string and re-read the bytes, whichever escape you meant. And python's stdout is cp1252 here, so a print() of non-ASCII raises UnicodeEncodeError BEFORE the write - the file is left untouched and the break-the-fix test then passes for the wrong reason, so assert the file actually changed before trusting any result"
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

**It also eats a DOUBLED escape you wrote on purpose** (2026-10-06, the Production Planner's
language toggle). A doubled backslash-u0600 in a non-raw replacement string is meant to put the
five characters of the escape in the file; it puts the real U+0600 there instead, and a doubled
backslash-n inside a JS template literal becomes a real newline. Neither BREAKS anything - a
literal character range and a multi-line template literal are both valid JS - so nothing warns
and nothing fails. The file just carries invisible bytes where you wrote readable escapes, which
the next reader cannot see at all. `grep -c 'u0600' <file>` returning 0 immediately after you
wrote that escape is the tell, and it cost four rewrites of one test file.

**And on THIS box python's stdout is cp1252, so a `print()` of non-ASCII KILLS THE SCRIPT BEFORE
IT WRITES** (2026-10-06, the same toggle work). Injecting an Arabic refusal back into
`service.ts` to watch a guard fire, the script read the original out of git correctly and then
printed it for the log: `UnicodeEncodeError: 'charmap' codec can't encode characters` — raised on
the PRINT, before the `write`. So the file was never touched, and the test run that followed went
GREEN and read exactly like a guard that does not work. Two wasted cycles, both of which looked
like evidence. Set `PYTHONIOENCODING=utf-8`, or print only lengths and booleans and never the
text itself; and when the text is non-ASCII, LIFT IT OUT OF GIT (`git show HEAD:<file>` plus a
regex) instead of escaping it by hand, which removes the escape question altogether.

🔴 **The general shape: a python edit that fails BEFORE the write leaves the previous content in
place, and a break-the-fix test then passes for the wrong reason.** Always assert the file
actually changed — `bool(re.search(..., open(p).read()))` after the write, printed as a boolean —
and only then run the test you expect to fail.

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
