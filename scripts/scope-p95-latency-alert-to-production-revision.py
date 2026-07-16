#!/usr/bin/env python3
"""Scope the phoenix-hr p95 latency alert policy to production traffic only.

Background: `deploy-cloud-run.yml` deploys every revision with NO traffic and
a `sha-<8hex>` tag, then smoke-tests it directly via its tag URL
(`https://sha-xxxxxxxx---phoenix-hr-<hash>-<region>.a.run.app`) *before*
promoting it to production traffic. That tag URL is a real, separately
routable Cloud Run endpoint, so a cold-starting smoke-test/health-check hit
against it is indistinguishable, in the built-in
`run.googleapis.com/request_latencies` metric, from a slow request against
live production traffic — both just carry a `revision_name` label, with no
signal for whether the request came in through a 0%-traffic tag URL or the
promoted default/custom-domain URL production users actually hit.

This was investigated after the 2026-07-16 22:03 UTC p95-latency alert. Log
inspection showed that specific alert was actually driven by a genuinely slow
production request (`/api/notifications/process`, ~18.4s, via
phoenix-hr.satopharma.com) on a revision that was still 100%-traffic at the
time and only later got superseded and demoted to a 0%-traffic tag â€” already
covered by the p95 threshold/duration the owner tuned the same day (8s, near-
immediate -> 30s sustained 10m, mutated 2026-07-16T22:07:07Z). Confirmed via
`deploy-cloud-run.yml`'s post-deploy smoke test that the tag-URL-cold-start
mechanism this script guards against is real and unaddressed by that
threshold tuning alone (it fires on every deploy, independent of duration).
This script is defense-in-depth for that separate, still-open mechanism, not
a fix for the incident that triggered the investigation.

What this does:
  1. Creates (idempotently) a Cloud Logging distribution metric,
     `phoenix_hr_production_request_latencies`, sourced from Cloud Run's
     automatic per-request log entries, filtered to exclude any request
     whose `httpRequest.requestUrl` host is a `sha-*` tag URL. Verified
     empirically (2026-07-16, live Cloud Logging query) that Cloud Run
     request logs populate `httpRequest.requestUrl` with the full
     scheme+host+path the client used, and that production traffic logs as
     either the custom domain (`phoenix-hr.satopharma.com`) or the plain
     default `*.run.app` host -- never the `sha-*---` tag-prefixed host.
  2. Updates the existing "Cloud Run p95 latency (phoenix-hr)" alert policy
     (found by display name -- its numeric ID is not hardcoded here since it
     is a per-project-creation value) so its condition filters on the new
     metric instead of the raw `run.googleapis.com/request_latencies`
     metric, preserving whatever threshold/duration/trigger/notification
     channels are live on the policy at apply time (it does not re-assert
     the 30000/600s values this script's author observed on 2026-07-16, in
     case they have since been tuned again).

Safety:
  - Read-only (--dry-run, the default): prints the exact metric payload and
    the before/after policy condition, applies nothing.
  - --apply is required to mutate anything. This still only touches Cloud
    Monitoring/Logging alerting configuration -- it never touches the live
    Cloud Run service, its traffic split, env vars, or scaling.
  - Idempotent: re-running with --apply after the metric/condition already
    match is a no-op.
  - Auth via `gcloud auth print-access-token` (must already be logged in to
    a project with `logging.logMetrics.*` and `monitoring.alertPolicies.*`
    permissions on phoenix-workforce-498619); no new Python dependency is
    added, matching scripts/cleanup-stale-cloud-run-tags.py.
"""

import argparse
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

METRIC_NAME = "phoenix_hr_production_request_latencies"
METRIC_FILTER = (
    'resource.type="cloud_run_revision" '
    'AND resource.labels.service_name="{service}" '
    'AND httpRequest.requestUrl!="" '
    'AND NOT httpRequest.requestUrl:"://sha-"'
)
POLICY_DISPLAY_NAME = "Cloud Run p95 latency ({service})"
NEW_CONDITION_DISPLAY_NAME = "p95 production-revision latency > threshold, sustained"


def get_access_token():
    # subprocess's default (shell=False) launches via CreateProcess on
    # Windows, which -- unlike a real shell -- won't resolve a bare
    # "gcloud" to the gcloud.cmd shim on PATH. shutil.which() does the
    # PATHEXT-aware lookup that finds it there (and is a harmless no-op
    # resolving straight to "gcloud" on Linux/macOS CI runners).
    gcloud = shutil.which("gcloud") or "gcloud"
    result = subprocess.run(
        [gcloud, "auth", "print-access-token"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def api_request(token, method, url, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code} calling {method} {url}:\n{detail}", file=sys.stderr)
        raise


def build_metric_payload(project, service):
    return {
        "name": METRIC_NAME,
        "description": (
            "Distribution of Cloud Run request latency (seconds) for "
            f"{service}, excluding requests routed via a sha-* tag URL "
            "(deploy-time smoke tests / cold, unpromoted preview traffic). "
            "Feeds the p95 latency alert policy so it only reflects "
            "traffic actually reaching production."
        ),
        "filter": METRIC_FILTER.format(service=service),
        "valueExtractor": "EXTRACT(httpRequest.latency)",
        "metricDescriptor": {
            "metricKind": "DELTA",
            "valueType": "DISTRIBUTION",
            "unit": "s",
        },
        "bucketOptions": {
            "exponentialBuckets": {
                "numFiniteBuckets": 30,
                "growthFactor": 2,
                "scale": 0.01,
            }
        },
    }


def fetch_existing_metric(token, project):
    url = f"https://logging.googleapis.com/v2/projects/{project}/metrics/{METRIC_NAME}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def ensure_log_metric(token, project, service, apply):
    payload = build_metric_payload(project, service)
    existing = fetch_existing_metric(token, project)

    if existing is not None:
        if existing.get("filter") == payload["filter"]:
            print(f"Log-based metric '{METRIC_NAME}' already exists with the expected filter. No change needed.")
            return
        print(f"Log-based metric '{METRIC_NAME}' exists but its filter differs.")
        print("  current filter:", existing.get("filter"))
        print("  desired filter:", payload["filter"])
        if not apply:
            print("(dry-run) would PUT updated metric definition.")
            return
        url = f"https://logging.googleapis.com/v2/projects/{project}/metrics/{METRIC_NAME}"
        api_request(token, "PUT", url, payload)
        print(f"Updated log-based metric '{METRIC_NAME}'.")
        return

    print(f"Log-based metric '{METRIC_NAME}' does not exist yet.")
    print(json.dumps(payload, indent=2))
    if not apply:
        print("(dry-run) would POST this metric definition.")
        return
    url = f"https://logging.googleapis.com/v2/projects/{project}/metrics"
    api_request(token, "POST", url, payload)
    print(f"Created log-based metric '{METRIC_NAME}'.")


def find_policy(token, project, service):
    display_name = POLICY_DISPLAY_NAME.format(service=service)
    url = (
        f"https://monitoring.googleapis.com/v3/projects/{project}/alertPolicies"
        f"?filter=display_name%3D%22{urllib.parse.quote(display_name)}%22"
    )
    result = api_request(token, "GET", url)
    policies = result.get("alertPolicies", [])
    if not policies:
        return None
    return policies[0]


def build_updated_condition(policy, project):
    condition = policy["conditions"][0]
    threshold = condition["conditionThreshold"]
    new_metric_type = f"logging.googleapis.com/user/{METRIC_NAME}"
    updated = json.loads(json.dumps(condition))  # deep copy
    updated["displayName"] = NEW_CONDITION_DISPLAY_NAME
    updated["conditionThreshold"]["filter"] = (
        f'resource.type="cloud_run_revision" AND metric.type="{new_metric_type}"'
    )
    # The new metric is DISTRIBUTION/seconds; the live built-in metric is
    # ms. Convert the threshold so the alerting semantics (e.g. "30s
    # sustained 10m") are preserved rather than silently reinterpreted as
    # 30ms. Only rescale if the existing filter targeted the ms-unit
    # built-in metric.
    if 'metric.type="run.googleapis.com/request_latencies"' in threshold["filter"]:
        updated["conditionThreshold"]["thresholdValue"] = threshold["thresholdValue"] / 1000
    return updated


def ensure_policy_scoped(token, project, service, apply):
    policy = find_policy(token, project, service)
    if policy is None:
        print(
            f"No alert policy found with display name "
            f"'{POLICY_DISPLAY_NAME.format(service=service)}'. Nothing to update.",
            file=sys.stderr,
        )
        sys.exit(1)

    current_filter = policy["conditions"][0]["conditionThreshold"]["filter"]
    new_metric_type = f"logging.googleapis.com/user/{METRIC_NAME}"
    if new_metric_type in current_filter:
        print(f"Policy '{policy['displayName']}' is already scoped to the production-only metric. No change needed.")
        return

    updated_condition = build_updated_condition(policy, project)
    print(f"Policy: {policy['displayName']} ({policy['name']})")
    print("  current condition filter:", current_filter)
    print("  current threshold:", policy["conditions"][0]["conditionThreshold"]["thresholdValue"])
    print("  new condition filter:    ", updated_condition["conditionThreshold"]["filter"])
    print("  new threshold (rescaled):", updated_condition["conditionThreshold"]["thresholdValue"])

    if not apply:
        print("(dry-run) would PATCH this policy's condition. Notification channels and duration are preserved as-is.")
        return

    patched = json.loads(json.dumps(policy))
    patched["conditions"] = [updated_condition]
    url = (
        f"https://monitoring.googleapis.com/v3/{policy['name']}"
        "?updateMask=conditions"
    )
    api_request(token, "PATCH", url, patched)
    print(f"Updated policy '{policy['displayName']}' to use the production-only metric.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default="phoenix-workforce-498619")
    parser.add_argument("--service", default="phoenix-hr")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually create/update the log metric and alert policy. Default is dry-run (print only).",
    )
    args = parser.parse_args()

    if not args.apply:
        print("Running in DRY-RUN mode. Pass --apply to make live changes.\n")

    token = get_access_token()
    ensure_log_metric(token, args.project, args.service, args.apply)
    print()
    ensure_policy_scoped(token, args.project, args.service, args.apply)


if __name__ == "__main__":
    main()
