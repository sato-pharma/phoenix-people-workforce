---
name: supabase-outstanding-invoices-banner-2026-11-02
description: "On 2 Nov 2026 15:05 Cairo the Supabase dashboard showed \"Outstanding invoices\" on the Gawish organization (production and staging) and \"Services restricted\" on Future Talents Hub. Point-in-time - re-read the banner before repeating it."
metadata:
  node_type: memory
  type: project
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-02T13:11:43.071Z
---

Read in the owner's Chrome, 2 Nov 2026 about 15:05 Cairo, on Settings, Infrastructure, changing nothing:
- Gawish organization (Pro), Phoenix HR and Phoenix-HR-Staging: "Outstanding invoices · Please pay your invoices to avoid service disruption". Production was still serving.
- Future Talents organization (Free), Future Talents Hub: "Services restricted · Your projects are unable to serve requests as your organization has used up its quota", tagged "Exceeding usage limits".
- Compute: Phoenix HR Small, staging Micro, Future Talents Hub Nano. Nothing on Medium, though Medium was reported from the dashboard at 14:55. Whether the invoices held that change back is unknown.
- The same page lists Medium as 4 GB of memory on SHARED compute ($0.0822/hour against Small's $0.0206); dedicated cores start at Large. The earlier plan's "Medium: dedicated 2 cores" was wrong.

**Why:** an unpaid invoice can reach the production database, which runs payroll, and it does not show in any log.

**How to apply:** if production's database starts refusing or pausing, read this banner early. Paying is his, on Supabase's billing screen; never pay, never put it in quoted words. Related: [[github-account-suspended-2026-11-02]], and I do not know whether the two are linked.
