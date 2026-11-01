---
name: railway-logs-without-a-deployment-id-reads-only-the-current-one
description: "railway logs --since with no deployment id silently returned zero rows for an earlier window; a before-and-after needs each deployment's id."
metadata:
  node_type: memory
  type: reference
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-01T23:07:08.336Z
---

`railway logs --http --since <t> --until <t>` with no deployment id read only the deployment serving now. On 2 Nov 2026 a window from before the last deploy came back as 0 rows with no error, and `--since 5h` stopped at that deployment's start (76 minutes back).

Zero rows here does not mean zero traffic. For a before-and-after, list the deployments and pass each one's id as the last argument, slice by time, and watch for the 5,000-line cap.
