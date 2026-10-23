---
name: gh-run-view-log-dies-with-a-stream-cancel-and-writes-zero-bytes
description: "gh run view --log / --log-failed can die with \"stream error: stream ID 1; CANCEL; received from peer\", exit 1 and a 0-byte file — piped into grep that reads as a job with no errors; gh api repos/OWNER/REPO/actions/jobs/<id>/logs returns the same logs fine."
metadata:
  node_type: memory
  type: project
  originSessionId: 788e24cb-3319-4202-a352-d6adcc9032ee
  modified: 2026-10-23T07:23:05.803Z
---

Reading a failed CI job's log on 2026-10-23 (PR 6302, run `39914758150`):

- `gh run view <run> --job <id> --log-failed` printed **nothing** for two jobs that had genuinely
  failed, and `--log` then failed with `failed to get run log: stream error: stream ID 1; CANCEL;
  received from peer`, **exit 1, 0 bytes written**.
- `gh api repos/Gawish-1997/phoenix-people-workforce/actions/jobs/<job id>/logs` pulled the same
  logs immediately — 43 KB and 559 KB.

**Why:** the download is an HTTP/2 stream the server cancels; `gh` surfaces it on stderr and still
creates the output file. It is transient and unrelated to whether the run finished — `--log-failed`
also legitimately returns nothing while a run is still in progress, so the two look identical.

**How to apply:** when a job's log comes back empty, go straight to the `gh api .../actions/jobs/<id>/logs`
endpoint rather than concluding the job had no errors or waiting for the run to "settle". And never
pipe the download into `grep` — the pipeline's exit status is grep's, so a 0-byte failed download
prints nothing and reads exactly like a clean job. Download to a file, check the byte count, then
grep the file. This is the same shape as [[verify-the-emitted-artifact-never-the-source]] and the
standing rule about never piping a command whose exit code is the answer.
