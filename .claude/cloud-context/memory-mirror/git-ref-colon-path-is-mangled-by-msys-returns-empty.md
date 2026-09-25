---
name: git-ref-colon-path-is-mangled-by-msys-returns-empty
description: "\"In Git-Bash on Windows, `git show REF:path` / `cat-file -e REF:path` is rewritten by MSYS path conversion — but ONLY when the path's FIRST character is a dot (`.github/…`, `.claude/…`, `.gitignore`, `.env*`); `mobile/.gitignore` and every ordinary path pass through untouched. It does NOT return empty: it fails LOUDLY on stderr with `fatal: ambiguous argument 'REF\path'`, and a pipe turns that into a confident `0` or the sha256 of nothing — so a 'did this content land on main?' check reports MISSING for a file that is plainly there. Fix with `MSYS_NO_PATHCONV=1`, a `./` in front of the path, or the PowerShell tool. The SAME conversion silently eats a git grep / rg SEARCH PATTERN containing a leading-slash path, returning ZERO matches for code that is plainly there.\""
metadata: 
  node_type: memory
  type: project
---

**The failure.** Verifying that a merged worktree could be deleted (2026-08-19, `_wt-resend-nudge`,
PR #2228) I compared each touched file against `origin/main` with

```sh
git -C "$P" show "origin/main:$f" | sha256sum
```

For `.env.github-secrets.example` this printed `e3b0c44298fc1c14…` — **the sha256 of the empty
string** — and the check reported the file MISSING from `origin/main`. It is not missing. MSYS had
rewritten the argument to `origin\main;.env.github-secrets.example` (slash → backslash, colon →
semicolon, because `a/b:c/d` looks like a `PATH`-style list to the conversion layer). Git errored,
stderr went unnoticed inside the pipe, and `sha256sum` hashed nothing.

**Why it is dangerous rather than annoying:** the wrong answer is the *alarming* one. An empty
result makes tracked, already-merged content look absent or unique, which is exactly the signal
that stops a deletion — or, inverted, could make you "rescue" files that need no rescuing. It fires
selectively: the same loop resolved `src/lib/outstation/service.ts` correctly, so a spot-check on
one file proves nothing about the next. **It is not selective — the rule is measured in the
2026-09-21 section below: the mangling fires only when the path's FIRST character is a dot, which
`.env.github-secrets.example` is and `src/lib/…` is not.**

**How to apply:**
1. Export `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL='*'` before **any** `REF:path` form —
   `git show`, `git cat-file`, `git rev-parse`, `git checkout REF -- path`.
2. Prefer `git rev-parse "REF:path"` and compare **blob OIDs**, not piped bytes. A mangled ref
   makes `rev-parse` fail loudly with a non-zero exit instead of yielding a plausible empty hash.
3. Never hash the output of a git command through a pipe without checking the exit status — the
   pipe hides the error and `sha256sum` of nothing is a valid-looking hash.
4. **Compare blob OIDs, not file bytes,** when asking "is this content already safe in git?" The
   same file was 557 bytes in the worktree and 581 in the primary checkout — a pure CRLF/LF
   difference — while both resolved to the identical blob `b966b1ab`. Byte comparison reports a
   difference that does not exist.

Related: [[shell-grep-unusable-use-git-grep-or-rg]] (the other Git-Bash-on-Windows tooling trap),
[[strip-worktree-payload-before-removing-it]], [[worktree-remove-permission-denied-still-deregisters]].

---

## The same conversion eats a SEARCH PATTERN (2026-08-30)

Auditing which admin-group pages forward a portal viewer to their portal twin:

```sh
git grep -c 'redirect("/employee-portals/' -- 'app/(admin)'   # -> 0
rg -n --fixed-strings 'redirect("/employee-portals/' app       # -> 0
```

Both returned **nothing**, no error, exit 1. The string is in 41 files; printing line 14 of one of
them showed it plainly. MSYS had rewritten the `/employee-portals/` inside the *pattern* into a
Windows path, exactly as it does a `REF:path` argument. It hits `rg` too, because the mangling
happens in the argv layer before the tool ever sees it — this is not a git bug.

**Worse than the REF:path case in one specific way: zero matches reads as GOOD NEWS.** An empty
`git show` looks broken and makes you check. An empty grep looks like the pattern is absent from
the codebase, which is usually the answer you were hoping for. It reached a PR description as
"six pages" when the truth was 41 — a sevenfold undercount, stated as measured fact.

**How to apply:** export `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` before any sweep whose
pattern contains a URL or an absolute path, and never quote a count from one without it. Cheapest
tell when a sweep returns 0: re-run it on a distinctive fragment carrying no leading slash
(`employee-portals/approvals`, not `"/employee-portals/`) and see whether the zero survives.

Related: [[shell-grep-unusable-use-git-grep-or-rg]] and
[[heredoc-eats-backslashes-and-makes-a-test-that-only-passes]] — same family: the shell layer
silently altering what you thought you asked for.

---

## The condition, measured — 2026-09-21

**It is not every `REF:path`. The dot has to START the path.** Measured on `origin/main` in
`phoenix-workforce`, same shell, byte counts with and without `MSYS_NO_PATHCONV=1`:

| path | without | with | |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | 0 | 47,311 | **mangled** |
| `.claude/settings.json` | 0 | 6,129 | **mangled** |
| `.gitignore` | 0 | 5,015 | **mangled** |
| `.env.example` | 0 | 13,841 | **mangled** |
| `mobile/.gitignore` | 1,137 | 1,137 | fine |
| `package.json` | 20,391 | 20,391 | fine |
| `tests/run-tests.ts` | 477,124 | 477,124 | fine |
| `supabase/config.toml` | 15,317 | 15,317 | fine |

`mobile/.gitignore` is the row that pins it: a dot-name *inside* the path is harmless, so "dotfiles
are dangerous" is the wrong generalisation and would have sessions exporting the variable for reads
that were never at risk. The trigger is a dot followed by a name at the START, which is where CI
config, hooks and settings live — precisely the files a session verifies most.

**This file already held the evidence, a month before the rule was named.** The 2026-08-19 loop above
mangled `.env.github-secrets.example` and resolved `src/lib/outstation/service.ts` correctly, and
that was written up as firing "selectively". It was not selective. The first character of one is a
dot and of the other is not.

**"Returns EMPTY" was wrong, and that matters.** It fails LOUDLY — `fatal: ambiguous argument
'origin\main;.gitignore'` on **stderr**, exit 128. What is empty is only what survives a pipe, which
is why `sha256sum` hashed nothing in 2026-08-19 and why a `| grep -c` reads a confident `0`. Nothing
in the output of the pipeline looks broken. Verifying PR #4148's CI guard this way read **0** against
a real **4 of 4** (2026-09-21).

**`ambiguous argument` means "conversion fired" — NOT that the file exists.** Untreated, a dotted
path answers `ambiguous argument` whether it is there or not; these two are byte-identical:

    dotted + PRESENT   fatal: ambiguous argument 'origin\main;.gitignore': unknown revision or path not in the working tree.
    dotted + ABSENT    fatal: ambiguous argument 'origin\main;.github\workflows\no-such.yml': unknown revision or path not in the working tree.

The conversion happens before git resolves anything, so git never gets far enough to know. **The
tell is a TWO-STEP:** re-run with `./` in front — bytes back means the trap was eating a real file,
`path '…' does not exist in '<ref>'` means it was never there. Measured, nothing exported:
`./.gitignore` → 5,015 bytes; `./.github/workflows/no-such.yml` → the absence message. Only once the
conversion is disarmed do an ordinary `path … does not exist` and the mangled form stop wearing each
other's words. Reading `ambiguous argument` as *MSYS ate a real file* is the same false positive as
the zero this memory is about, one layer up — it shipped inside the correction (#4156) and was
fixed by #4160 the same night.

**A `./` in front disarms it with nothing exported** — `git show origin/main:./.github/workflows/ci.yml`
reads all 813 lines, and a `./` on a path that was already fine changes nothing. The PowerShell tool
does no path conversion at all and needs no variable.

**On `git rev-parse` (point 2 above): the advice holds, with one catch.** A mangled ref exits **128**,
so the status is honest — but it also prints the mangled argument, `origin\main;.gitignore`, to
**stdout**. Capture that into a variable and you have a plausible-looking "OID" that is not one.
Compare the exit status, never the captured string.

The account, with the near-fixes that do NOT work (quoting, `git cat-file -p`, and `> file`, which
writes 0 bytes): `docs/agents-session-traps.md`, "A mangled `git show` read as 'the fix is not
there' — 2026-09-21". Cue in the **Shell and tooling** cluster of
`docs/agents-session-traps-clusters.md`. The filename of this memory still says "returns empty"
because `AGENTS.md`, both docs and the memory map all cite it by that slug; the slug is an address,
not a claim.

Related: [[tz-africa-cairo-silently-returns-utc-in-msys]] — the same shape in a different MSYS gap,
a command that returns a confident wrong value instead of failing.
