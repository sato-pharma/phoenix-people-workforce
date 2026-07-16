#!/usr/bin/env python3
"""Prune stale SHA-tagged Cloud Run revisions, keeping the newest N.

Each deploy in .github/workflows/deploy-cloud-run*.yml creates a new revision
with a `sha-<8hex>` tag and (for phoenix-hr) `--min-instances 1`, which
reserves 1 vCPU permanently even at 0% traffic. Left unpruned, these
accumulate across every deploy and can exhaust the region's CPU quota,
failing a future deploy before it can even take traffic (happened
2026-07-13 and 2026-07-14 on phoenix-hr).

Safety rules:
  - The tag currently receiving traffic (percent > 0) is never a removal
    candidate, regardless of age.
  - Only tags matching `sha-*` are touched; manually created tags (e.g. a
    debugging tag) are left alone.
  - Always lists what would be kept/removed before calling `--remove-tags`.
  - Exits non-zero (but does not raise) if nothing needs removing, so
    callers can treat this as best-effort and safe to no-op.
"""

import argparse
import json
import subprocess
import sys


def gcloud_json(args):
    result = subprocess.run(
        ["gcloud", *args, "--format=json"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def select_removals(service, revisions, keep_n):
    """Pure decision logic, isolated from gcloud I/O so it can be unit-tested.

    Returns (keep, remove, live_tags) where keep/remove are lists of
    (tag, revisionName, creationTimestamp) tuples.
    """
    created_at = {r["metadata"]["name"]: r["metadata"]["creationTimestamp"] for r in revisions}
    traffic = service.get("status", {}).get("traffic", [])

    candidates = []
    live_tags = set()
    for entry in traffic:
        tag = entry.get("tag")
        if not tag:
            continue
        if (entry.get("percent") or 0) > 0:
            live_tags.add(tag)
            continue  # never a cleanup candidate, regardless of age
        if not tag.startswith("sha-"):
            continue  # leave manually-created tags (e.g. a debugging tag) alone
        revision = entry.get("revisionName")
        candidates.append((tag, revision, created_at.get(revision, "")))

    candidates.sort(key=lambda c: c[2], reverse=True)  # newest first
    keep, remove = candidates[:keep_n], candidates[keep_n:]
    return keep, remove, live_tags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--keep", type=int, default=3, help="tags to keep (default: 3 = live + 2 rollback buffer)")
    args = parser.parse_args()

    common = ["--region", args.region, "--project", args.project]

    print(f"Fetching current traffic tags for {args.service}...")
    service = gcloud_json(["run", "services", "describe", args.service, *common])

    print("Fetching revision creation timestamps...")
    revisions = gcloud_json(["run", "revisions", "list", f"--service={args.service}", *common])

    keep, remove, live_tags = select_removals(service, revisions, args.keep)

    print(f"Live tag(s) (never touched): {sorted(live_tags) or ['none']}")
    for tag, revision, ts in keep:
        print(f"  KEEP   {tag}  ({revision}, {ts})")
    for tag, revision, ts in remove:
        print(f"  REMOVE {tag}  ({revision}, {ts})")

    remove_tags = {t for t, _, _ in remove}
    if live_tags & remove_tags:
        print("REFUSING to proceed: a live tag ended up in the removal set.", file=sys.stderr)
        sys.exit(1)

    if not remove_tags:
        print("Nothing to clean up.")
        return

    joined = ",".join(sorted(remove_tags))
    print(f"Removing stale tags: {joined}")
    subprocess.run(
        [
            "gcloud",
            "run",
            "services",
            "update-traffic",
            args.service,
            *common,
            f"--remove-tags={joined}",
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
