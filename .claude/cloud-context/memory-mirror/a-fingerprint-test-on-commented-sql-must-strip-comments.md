---
name: a-fingerprint-test-on-commented-sql-must-strip-comments
description: "A test that asserts a migration selects a column, or lacks a keyword, must strip `--` comments first — a well-documented migration names its own columns and keywords in prose, so the assertion passes on the comment and cannot fail."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
  modified: 2026-10-10T10:45:02.606Z
---

`tests/auth-session-bundle.test.ts` asserted the RPC selects `is_test_persona`. Deleting that column from the `SELECT` left the test **green**, because the comment above the `SELECT` also names it. The same file had already hit this once and fixed it in one place only: it strips comments before asserting `security definer` is absent, precisely because the migration's prose explains *why* it is absent. Seven assertions were reading the raw file; all seven now read the stripped SQL.

**Why:** a source-fingerprint test is the cheapest way to pin SQL that CI cannot execute, and this failure mode is invisible — the test keeps passing, so nothing tells you the pin is dead. It bites hardest on exactly the migrations worth pinning, since those are the ones carrying the measurements and the security argument in comments.

**How to apply:** in any test that reads a `.sql` file, build `executableSql` once, immediately after the read — `src.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")` — and assert against that, for both presence and absence checks. Check no string literal in the file contains `--` first. 🔴 **The proof is the break, not the green:** delete the column and watch the assertion fire. Here the break was caught only because a *second* file (`tests/test-accounts.test.ts`) pinned the same columns and went red while this one stayed green. Related: [[verify-the-emitted-artifact-never-the-source]], [[the-cutover-guard-pins-an-exact-count-of-read-sites]].
