---
name: direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase
description: "access.hrId is ALWAYS lower-case (canonicalHrIdKey), but direct_order_requests.requester_hr_id and direct_order_pharmacies.created_by_hr_id store both cases — an exact .eq() hid 28% of reps' own orders, silently"
metadata: 
  node_type: memory
  type: project
  originSessionId: 95a9153c-7cad-40ba-8918-05de11f9c69f
  modified: 2026-08-23T05:53:58.507Z
---

**`access.hrId` is always lower-case. Direct Orders' hr-id columns are not.** Found 2026-08-23,
fixed in PR #2316.

`normalizeHrId` → `canonicalHrIdKey` → `.trim().toLowerCase()`, so **every** `access.hrId` in a
request context is lower-case. But these two columns hold whatever case the submitting session had:

| Column | Rows | Lower | Upper |
| --- | --- | --- | --- |
| `direct_order_requests.requester_hr_id` | 50 | 36 | 14 |
| `direct_order_pharmacies.created_by_hr_id` | 41 | 40 | 1 |

**The same person appears in BOTH cases** — `B-154`/`b-154`, `B-12`/`b-12`, `B-94`/`b-94`,
`AI-0007`/`ai-0007`. So `.eq("requester_hr_id", access.hrId)` returned only the lower-case half:
**14 of 50 orders (EGP 522,282.50) were invisible to the rep who submitted them**, and `B-74`
(Ahmed Mohamed Ahmed Mohamed Abdallah) saw **none** of his two — his "My direct orders" page was
simply empty, with EGP 266,112 behind it.

**Nothing errored and nothing logged.** The list just came back short. That is the whole danger:
a case-sensitivity bug on a "my own things" filter looks exactly like "this person has no orders",
so it is never reported as a bug.

**Always filter these columns with `.in(col, hrIdLookupKeys(value))`** (`src/lib/hr-id.ts` — yields
trimmed/lower/upper/canonical, and routes the `aaa`→`aa` alias). Never `.eq`. The PostgREST `.or()`
string form has the same trap — use `col.in.(${quoteInList(hrIdLookupKeys(x))})`, not `col.eq.${x}`.
`tests/direct-orders-hr-id-case.test.ts` scans the whole module and fails on any exact match.

**The split is historical, not growing:** every upper-case row predates **2026-08-05**; every row
since is lower-case. So this was fixed on the READ side only — no bulk `UPDATE` on live rows.

**`marketing_requests.requester_hr_id` is 100% upper-case**, which is why
`home-snapshot.ts` forcing `.toUpperCase()` there is correct and must not be "fixed" to match this.
**Do not assume a shared column NAME implies a shared convention** — check the table you are
actually querying.

Related: [[activity-events-hr-id-is-mixed-case-not-lowercase]] (same class, different table),
[[employees-line-name-column-is-null-in-production]], [[how-to-attribute-a-production-write]].
