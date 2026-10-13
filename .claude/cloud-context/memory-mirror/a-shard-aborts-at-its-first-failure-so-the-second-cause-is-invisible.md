---
name: a-shard-aborts-at-its-first-failure-so-the-second-cause-is-invisible
description: "run-tests-sharded dies on the first failing test, so each red shard shows ONE cause and everything behind it never ran — read BOTH shards' FAIL lines before calling a red run diagnosed, and remember a new app/api route is red from its first commit until it is in the access registry."
metadata:
  node_type: memory
  type: project
  originSessionId: 0be92338-9743-4b23-ba29-cd28bd8597f5
  modified: 2026-10-13T00:43:29.306Z
---

`pnpm run test` shards into two, and a shard raises an uncaught exception at its first failing
test — so a red `validate` reports **one cause per shard and no more**, with every test after it
unrun and invisible. On 2026-10-13 PR #5822 went red on five consecutive commits; `--log-failed`
piped to `tail` showed only shard 2's cause (a module-memory rules line over its 1,200-byte cap)
while shard 1 had been failing from the very first commit on something else entirely.

**Read both shards before claiming you know why a run is red:**

```
gh run view <id> --log-failed | grep -oE '\[shard [12]/2\] (FAIL .*|AssertionError .{0,160})' | sort -u
```

And the shard-1 cause is worth knowing on its own: **`access registry coverage` asserts that EVERY
`app/api` route appears in `src/lib/security/access-registry.ts`**, so a newly added route — a cron
route included — makes `validate` red from the commit that adds it, with a message naming the
missing `GET`/`POST` pair. The entry carries a prose account in the sibling style (what it does, the
incident behind it, what it reads and writes, whether its bodies hold PII, what guards it); a cron
route is `tokenApi({ authMode: "cron-secret", … })`. `runCronControlRegistryTests` separately
cross-references the job registry against it.

Related: [[mains-required-checks-are-four-not-six-checks-carries-the-suite]].
