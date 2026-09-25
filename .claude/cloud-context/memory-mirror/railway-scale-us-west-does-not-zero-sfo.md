---
name: railway-scale-us-west-does-not-zero-sfo
description: "railway service scale us-west=0 maps to us-west2, NOT sfo — leaves the old replica running and double-starts the in-process CRM poller."
metadata: 
  node_type: memory
  type: reference
  originSessionId: e32dec38-db15-4bf6-92d6-6bcd91afa4d7
  modified: 2026-08-09T12:11:05.956Z
---

`railway service scale` takes friendly region aliases (`us-west`, `us-east`, `eu-west`,
`southeast-asia`) **or** raw region IDs — and **the alias does not necessarily resolve to the region
the service is actually in.**

Hit live 2026-08-09 moving production off `sfo`:

```
railway service scale ... eu-west=1 us-west=0
→ {"regions":{"europe-west4-drams3a":{"numReplicas":1},"sfo":{"numReplicas":1},"us-west2":null}}
```

`us-west` resolved to **`us-west2`**, so `sfo` was left at 1 replica — briefly **2 replicas on 2
continents**. The fix is to name the raw ID:

```
railway service scale ... europe-west4-drams3a=1 sfo=0
→ {"regions":{"europe-west4-drams3a":{"numReplicas":1}}}
```

**Why this is dangerous here, not just untidy:** `src/lib/crm/live-poller.ts` is an *in-process*
singleton that WRITES to production Supabase, gated only on `PHOENIX_LIVE_CRM_POLL=true` +
production build. Its guards stop a dev machine starting a second writer — they do **not** stop a
second Railway replica. Two replicas = two concurrent pollers upserting the same CRM visits.

**Always read the returned JSON and confirm the old region is gone**, then verify exactly one
`RUNNING` instance:

```bash
railway api 'query { serviceInstance(serviceId:"30356676-116b-4886-ac6e-89041d80185e", environmentId:"cd5600e6-99dd-4b1c-80b2-16af8770abef") { region numReplicas } }'
```

`railway api` authenticates itself — never read `~/.railway/config.json` for the token.
Note `serviceInstance.region`/`numReplicas` read `null` once a multi-region config is set; the scale
command's own JSON output is the authority. Volumes are region-locked, so check
`project { volumes }` is empty before moving (it was).

Related: [[railway-production-region-is-now-eu-west]].
