---
name: a-windows-path-written-through-an-escape-turns-08-into-a-nul-byte
description: "A Windows path written through anything that interprets escapes turns \\0 into a real NUL byte — F:\\PHX backup\\08-worktree-uncommitted became backup<NUL>8-worktree, which made git and grep classify the auto-loaded MEMORY.md as BINARY so every repo-wide search over it returned a FALSE ZERO; tests/no-nul-bytes-in-source.test.ts in the required validate job is the backstop, and a NUL in the memory index also truncates any C-string reader at that line."
metadata:
  node_type: memory
  type: project
  originSessionId: 1baaa0f5-9436-457f-8907-da9439516d28
  modified: 2026-10-04T05:01:30.588Z
---

Measured 2026-10-04. A `MEMORY.md` inbox pointer naming the snapshot folder was written as

```
F:\PHX backup\08-worktree-uncommitted
```

through a writer that interprets escapes. `\0` is the NUL escape, so it consumed **the backslash and
the zero**: the bytes on disk became `PHX backup` + `0x00` + `8-worktree-uncommitted`. One byte, in
one line, in the file that auto-loads on every request.

**The damage is not the byte, it is what the byte does to searching.** `git` and `grep` call any
file containing a NUL **binary** and skip it:

```
$ grep -n "snapshot" MEMORY.md
Binary file MEMORY.md matches          <- no line, no text, no match list
$ git diff --stat
 .claude/cloud-context/memory-mirror/MEMORY.md | Bin 13928 -> 5531 bytes
```

So a repo-wide or index-wide search over that file returns a **false zero** — the shape of "this
fact is not recorded anywhere" — and a diff shows `Bin`, which hides the content change completely.
A session reading either result concludes the opposite of the truth. On top of that, a NUL in the
memory index truncates any reader treating it as a C string **at that line**, so everything below it
can silently stop loading.

🔴 **THE REPO ALREADY GUARDS THIS AND IT WORKS** — `tests/no-nul-bytes-in-source.test.ts`, inside the
required `validate` job. It named the byte precisely, independently:

```
FAIL no raw NUL bytes in tracked source
  .claude/cloud-context/memory-mirror/MEMORY.md:34 (1 NUL byte)
```

But note **where** it caught it: the mirror, in CI, after `sync-cloud-context.mjs` had already copied
the bad bytes toward cloud. Nothing on the laptop objects — the live memory folder is not tracked, so
a NUL can sit in `MEMORY.md` for as long as it takes the next fold to mirror it. The red `validate`
is the *only* thing that ever says so.

**How to write a Windows path into a file safely**

- Prefer the Write tool, or `io.open(..., 'w')` with the literal text — nothing that re-reads `\`.
- In Python, build the separator from its code point rather than typing it: `bytes([92])` / `chr(92)`.
  A `'\\0'` in a source string is fine; a `'\0'` is a NUL, and the two look identical at 4am.
- Then **verify in bytes, not by eye**: `tr -dc '\000' < f | wc -c` must print 0, and `grep -c` on
  the path must print a count rather than `Binary file … matches`.

Measured the same day, so the sweep is cheap and worth doing after any bulk write: of **10,183**
tracked files, 201 contain a NUL and every one is a genuine binary — fonts, images, `.xlsx`, `.wasm`,
`.pdf`. Any **text** file in that list is this bug.

Same family as [[a-source-assertion-is-satisfied-by-the-comment-explaining-the-call]] and
[[a-pr-check-grades-the-merge-so-it-can-fail-on-a-commit-you-never-wrote]] — a measurement that comes
back clean because the tool never looked, not because the thing is clean. The MSYS sibling is the
path-mangling one, where `git show origin/main:<path>` becomes `origin\main;...` and a swallowed
error reads as a confident negative.
