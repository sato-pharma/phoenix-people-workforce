---
name: assigning-to-groups-in-bash-is-silently-ignored
description: "a bash script's own GROUPS=( ... ) array is silently ignored — GROUPS is bash's own special array of the user's group ids, so the loop runs once over a number like 197609"
metadata:
  node_type: memory
  type: project
  originSessionId: c6c5b9e1-3dc9-4ddb-bddb-2f58c01d2ce3
  modified: 2026-10-12T23:08:23.378Z
---

`GROUPS` is a bash **special variable** (like `UID`, `EUID`, `PIPESTATUS`): bash keeps it as the
array of the current user's group ids and ignores an assignment to it. There is no error, no
warning, and `set -u` does not fire, because the name IS set — just not to what the script wrote.

Measured here on 2026-10-13 while batching the admin-shell role sweep: a script holding

    GROUPS=( "/admin /admin/people-management …" … six groups … )
    for group in "${GROUPS[@]}"; do … done

printed `GROUP 1 of 1: 197609` and then hit the URL `197609` **132 times** — twelve seats × the one
phantom group — each answering `000` in 30 microseconds, which reads exactly like a dead dev server
or a dropped ssh forward. On MSYS/Git-Bash under Windows the value is a single Windows group id, so
the symptom is one numeric "page" rather than an empty loop.

**Why:** `${#GROUPS[@]}` was 1 and `${GROUPS[@]}` was the real group id. Renaming the array to
`PAGE_GROUPS` made it 6 immediately — the proof, in one line:

    bash -c 'A=( "/x /y" "/z /w" ); echo ${#A[@]}'   # 2
    bash -c 'GROUPS=( "/x /y" "/z /w" ); echo ${#GROUPS[@]}'   # 1

**How to apply:** never name a shell array `GROUPS` (nor `UID`, `EUID`, `PPID`, `SECONDS`,
`RANDOM`, `LINENO`, `FUNCNAME`, `BASH_*`, `PIPESTATUS`, `OPTARG`, `IFS`, `PATH`). Prefix sweep
collections — `PAGE_GROUPS`, `ROLE_GROUPS`. And when a loop over a literal array runs the wrong
number of times, print `${#ARR[@]}` before blaming the network: see
[[a-page-redirect-answers-200-with-a-meta-refresh]] for the other way a role sweep lies about what
it measured.
