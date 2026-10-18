---
name: the-preview-mirrors-loose-objects-must-be-group-readable
description: phx-live (and phx-preview until it was retired 2026-10-17) dies with "upload-pack: not our ref 0000…" when a loose object in /srv/phx-preview-mirror.git is group phx — the reader (phxlive, through group phxpreview, which is why that user and group stay) cannot read it, so the ref advertises zeros. The guard lives in preview-scope.sh refresh_preview_mirror.
metadata:
  type: project
---

`phx` fetches GitHub into `/srv/phx-preview-mirror.git`; `phxpreview` clones from it. Git's own
mkdir clears the setgid bit, so new loose objects land **phx:phx 0440** and `upload-pack`, running as
`phxpreview`, cannot open them — it advertises that ref as all zeros, the client dutifully sends
`want 0000000000000000000000000000000000000000`, and the fetch dies. `preview-sync.sh` runs under
`set -e`, so **both** previews (3000 and 3001) refuse to start, with the git error as the only clue.

Repaired 2026-10-09: `sudo chgrp -R phxpreview . && sudo chmod -R g+rX . && sudo find . -type d -exec
chmod g+s {} +`, plus `rm -f` of the one ref whose object was already unreadable, then a refetch.
Diagnose it with `GIT_TRACE_PACKET=1 git fetch --prune origin` as `phxpreview` and read the ref name
on the zero line. `core.sharedRepository` stays `0640` on purpose — the mirror must never be
group-writable. Related: [[board-fixture-rows-go-on-staging-not-production]].
