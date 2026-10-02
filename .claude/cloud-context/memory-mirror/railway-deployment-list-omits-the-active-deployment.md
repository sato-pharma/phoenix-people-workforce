---
name: railway-deployment-list-omits-the-active-deployment
description: "`railway deployment list` can omit the deployment that is actually SERVING — phoenix-headwind's 791 error lines were invisible until its active id came from `railway status`; and `railway status --json -p <proj>` refuses without `-e` too."
metadata:
  node_type: memory
  type: reference
  originSessionId: 08f11fd9-5353-4d59-9fba-bc86e4eec1c4
  modified: 2026-10-02T21:26:19.454Z
---

Measured 2026-10-02 while sweeping every Railway service in Phoenix-HR-Workforce production.

**`railway deployment list --limit 100` returned 100 rows for `phoenix-headwind`, every one
`SKIPPED`, and none of them was the deployment serving `mdm.satopharma.com`.** That service's live
deployment is from 27 Sept; the list was 100 skipped build events from the days since. So a sweep
built on "iterate the deployment list and pull each one's logs" read **zero log lines** for a
service that holds **791 error-level lines**, including a `SEVERE` Tomcat startup failure
(`FileNotFoundException: /usr/local/tomcat/ssl/hmdm.jks`, so the 8443 connector never came up) and
four failed console file uploads. The whole service looked clean.

**The active id is in `railway status`, not in the deployment list:**

```bash
railway status --json -p <projectId> -e <envId>
# -> environments[].serviceInstances[].activeDeployments[].id  and  .latestDeployment.id
```

Union those into whatever the list gave you before pulling logs. `activeDeployments` is also how you
tell a service that is SERVING from one that merely has a SUCCESS row — `ftp-portal/web` has
`active=0, latest=none` and answers Railway's edge 404.

**Two smaller shapes from the same sweep:**

- **`railway status --json -p <project>` errors with `--environment is required when using --project`.**
  Always pass both, or it returns nothing and a JSON.parse of it throws somewhere unhelpful.
- **`railway` on PATH here is an npm shim, not an executable.** `execFileSync("railway", …)` fails
  `ENOENT`; the binary is
  `~/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe`. A sweep script that silently
  skipped all 13 services with `spawnSync railway ENOENT` is what surfaced this.

Deploy logs for a **REMOVED** deployment *are* retained, so iterating ids is still the right way to
reach history — `--since` cannot look past a single deployment's own lifetime. Related:
[[railway-http-logs-only-cover-the-current-deployment]].
