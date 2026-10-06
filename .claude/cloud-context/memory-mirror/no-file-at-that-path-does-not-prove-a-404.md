---
name: no-file-at-that-path-does-not-prove-a-404
description: "a missing `app/**/<path>/page.tsx` NEVER proves an href is dead — a rewrite, a declared redirect or a route group can serve a path with no file at it. Read proxy.ts and next.config.ts's redirects()/rewrites() before calling any link broken, and check whether a repo-wide test already covers the class. This session filed a wrong bug off four correct reads"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T05:55:46.998Z
---

Recorded 6 Oct 2026 after this session reported a rail link as dead and filed a task to fix it. It
was **wrong**, and the user had started the task before the retraction. The `/hr` specifics are a
PLATFORM fact and live in module memory — `.claude/rules/platform.md`, `### Navigation` — not here;
this note is the general trap. Related: [[the-nav-catalog-is-not-the-rendered-sidebar]].

**The reasoning that failed, step by step — each step true, the conclusion false:** `git ls-files`
shows no such route segment · a `**/page.tsx` glob finds nothing · there is no catch-all · a
`git grep` of the path returns only the nav row. Four independent reads, all correct, and the
inference *"so it 404s"* still does not follow, because **a path can be served with no file at
it**: a `proxy.ts` rewrite, a declared redirect in `next.config.ts`, or a route group.

🔴 **And the wrong fix was worse than the non-fix.** "Repoint the row at the un-prefixed address"
looked harmless and would have been a double regression — the shell redirects that seat straight
back into the namespace, and an existing test requires those rows to be authored under the prefix.
A proposed repair that merely looks like a no-op deserves the same scrutiny as a risky one.

🔴 **A repo-wide test already covering the class is the tell.** `tests/hr-url-namespace.test.ts`
had asserted for weeks that every row of that namespace resolves to a real page. A defect this
obvious, in a repo this well tested, is usually a misread — so before filing, check what the
nearest existing test asserts. (The class is now pinned for all four nav catalogues by
`tests/nav-hrefs-resolve.test.ts`.)

**How to apply:** before calling any href dead, read `proxy.ts` and `next.config.ts`'s `redirects()`
and `rewrites()`, then look for the test that would already have caught it. And when a retraction
is needed, read what the other session actually did before telling it to revert — mine had already
corrected course and written the guard, and my stand-down nearly destroyed it.
