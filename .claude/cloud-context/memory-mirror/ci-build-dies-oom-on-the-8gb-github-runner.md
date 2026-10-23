---
name: ci-build-dies-oom-on-the-8gb-github-runner
description: "A CI `validate` Build that died at \"Collecting page data\" with only \"The operation was canceled\" was the 2-CPU / 7.9 GB GitHub runner running OUT OF MEMORY (exit 137 \"Killed\", 23 Oct 2026); FIXED by #6282 (split compile/generate build + 6 GB swap, live 23 Oct) — never put one `pnpm run build` back."
metadata:
  node_type: memory
  type: project
  originSessionId: c54ec503-872a-4ce8-871b-eb511bd2ecd4
  modified: 2026-10-23T02:21:33.313Z
---

Measured 23 Oct 2026 (Cairo 03:22–04:46): three PR/main builds and one instrumented probe (run 39885106532, branch `codex/ci-build-memory-probe`) died at Next's "Collecting page data" stage. The PR-run logs show only `[ELIFECYCLE] Command failed.` + `##[error]The operation was canceled.`; the probe's log shows the real cause — `Killed`, `[ELIFECYCLE] Command failed with exit code 137`, and `The runner has received a shutdown signal` (the kernel OOM killer took the build and the runner agent). The runner is `ubuntu-latest` for a private repo: `nproc` 2, `free -m` 7937 MB RAM, 3071 MB swap. A healthy page-data stage takes 45–65 s; a dying one swaps for 1–6 min first.

Ruled out: the code (the same SHAs failed then passed unchanged), the image (all ubuntu-24.04 20261012.601), the Azure region (failures in westus2, westus3, westcentralus — passes too in westcentralus), runner version (2.338.0 everywhere), the Next 16.4.2 upgrade alone (its own builds passed).

**Why:** Next's build peaks near the 2-CPU runner's ~8 GB + 3 GB swap, so ordinary variance tips it over.
**How to apply:** a silent-cancel Build is NOT a code failure — re-run the failed job (`gh run rerun <id> --failed`) and never "fix" the change under review. **The lasting fix (owner chose "a bigger free fix", 23 Oct) SHIPPED: PR #6282, merged 23 Oct 05:12 Cairo as a5829c87d, live in production the same morning; main's run 39888346325 built split in 4.8 min, then the standalone assembly and the login smoke passed.** A silent-cancel Build AFTER 23 Oct is therefore a new problem — read the step's swap/memory first, never assume this note's old cause. The fix — ci.yml's Build adds 6 GB swap, then `next build --experimental-build-mode compile` and `... generate` as two processes. Measured (run 39886149636): page data went from 60 MB available / swap full / 8.2 min to 5.3 GB available / 3.6 min; the compile half still peaks ~6.9 GB, hence the swap. Pinned in `tests/ci-build-risk.test.ts`; Railway's Dockerfile unchanged. Never put the CI build back to one `pnpm run build`. Related: [[a-green-test-run-carries-no-type-signal-at-all]].
