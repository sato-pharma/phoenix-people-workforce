# Distribution Lists

Shipped 2026-09-11. Named, reusable email recipient groups, resolved fresh from the live employee
directory at send time.

🔴 **The composers, and nothing else, by the owner's decision.** On 2026-09-12 the lists were
unhooked from everything else: *"I don't want this distribution list to be linked with anything
except the email composer that you will build."* The
[Sato Email Composer](sato-email-composer.md) and the
[CEO Email Composer](ceo-email-composer.md) are the only things in the system that read a list.
Nothing sends to one automatically, and nothing else may be wired to one without the owner saying
so — pinned by `tests/sato-email-lists-only-composer.test.ts`, which fails if any file outside its
allowlist calls a resolver.

**There is still exactly ONE place where a picked list becomes an audience**, which is the point of
that allowlist: the CEO composer (added 2026-10-06, at the owner's request for a second composer)
calls `resolveSatoEmailAudience` in `src/lib/sato-email/service.ts` rather than resolving a list
itself. So one file is still the whole answer to "what does a send actually reach".

## Where to use it

- **UI:** `/admin/distribution-lists` (Super Admin) or `/hr/admin/distribution-lists` (HR
  Advisory — same page, different URL namespace). View every list's current resolved membership,
  edit a list's rules, and record what's on a Turbify mail alias.
- **API:** `GET /api/admin/distribution-lists` (list everything in scope), `POST
  /api/admin/distribution-lists/[listKey]` (edit one list).
- **Code:** [src/lib/distribution-lists/spec.ts](../src/lib/distribution-lists/spec.ts) (pure
  matching logic), [service.ts](../src/lib/distribution-lists/service.ts) (DB reads/writes),
  [access.ts](../src/lib/distribution-lists/access.ts) (who may manage which lists).

## Who can edit a list, and who can send to one

These are two different questions with two different answers, and conflating them is the mistake
this section exists to prevent.

| | Super Admin | HR Advisory (HR Business Partner) | Everyone else |
|---|---|---|---|
| **Edit a list's rules** (this screen) | every list | `hr_team` only | no access |
| **Send to a list** ([the composers](sato-email-composer.md)) | any switched-on list | any switched-on list | no access |

The **CEO** is the one addition to that bottom row: he may address any switched-on list from the
[CEO Email Composer](ceo-email-composer.md), and he cannot edit a list's rules.

Editing is narrow because a list's rule decides who receives company mail thereafter; sending is
wide because the owner said so on 2026-09-11 — both seats may address any list that is switched on,
and the composer shows the exact recipient count and asks for a confirmation before anything goes.

The edit rule is enforced per-request on the API route (`canManageDistributionList`), not only on
the screen, because hiding a row on the page is not a boundary — a hand-crafted request naming
`finance_team` would otherwise still go through. The allowlist is **fail-closed**: a list absent
from `HR_OWNED_LIST_KEYS` is invisible to her, so a list added later is private until somebody
decides it is hers. The opposite shape — "everything except a denylist" — would make each new list
editable by default, and the first one nobody remembered to deny would be a silent widening.

## How a list resolves

Two tables, migration [`20260911120000_distribution_lists.sql`](../supabase/migrations/20260911120000_distribution_lists.sql):

- **`distribution_lists`** — the rule. Six rule dimensions (`roles`, `line_ids`, `area_ids`,
  `department_ids`, `position_ids`, `region_codes`) are **ANDed together, ORed within one** —
  `roles={'Medical Rep'} + line_ids={3}` means "medical reps on line 3". An **empty** dimension
  means *no constraint*, not *matches nobody*. Static additions/removals sit alongside the rule:
  `included_hr_ids` (added on top of the rule match), `excluded_hr_ids` (removed last, always
  wins), `external_emails` (addresses with no employee behind them — an auditor, a distributor
  contact — skip the directory entirely).
- **`company_email_aliases`** — a register of Turbify mail-server aliases (Turbify has no API), so
  membership here is an **attestation** — what a human last saw in the control panel — never an
  observation. Each alias can point at a `distribution_list_key`; the page then shows the drift
  between what the list says should be on the alias and what was last recorded, split into
  `toAdd` and `toRemove` (with `toRemove` reasoned `left_company` vs `not_on_list` — the former is
  the one that matters, since it's a leaver still receiving company mail).

Two safety rules baked into the resolver ([spec.ts](../src/lib/distribution-lists/spec.ts)),
because this decides who receives company mail and a silent over-send can't be recalled:

- A list with **every** rule dimension empty resolves to **nobody**, not everybody. The only way
  to address the whole company is the explicit `all_employees` flag — something somebody turned
  on, never something a blank form did by itself.
- If a stored role name no longer exists in `phoenixRoles` (a role gets renamed), the list is
  **refused outright** rather than silently resolved without that filter — which would widen the
  audience instead of narrowing it.

`resolveDistributionListByKey` / `resolveAllDistributionLists` **fail closed**: an unreadable table
means zero recipients, reported through `warnings`, never a plausible-looking empty audience. The
composer renders those warnings on the preview, so the sender sees "this list came back short and
here is why" rather than a smaller number that looks deliberate.

## What's seeded today

- `hr_team` — the HR seats, plus Omar Anwar (`B-10`) by name. The one list the HR Business Partner
  may edit.
- `finance_team` — the Finance Manager, plus Adel El Sayed (`OF-0002`) by name.
- `all_medical_reps`, `all_district_managers`, `all_national_sales_managers` — company-wide,
  any line.
- One `line_<name>[_medical_reps|_district_managers]` triad per line (Anti Infective, Pedia, CNS),
  plus one `<line>_<region>_[medical_reps|district_managers]` pair per line × region (Alex-BHR,
  Cairo, Delta 1/2/3 where applicable, Giza, Upper Egypt 1/2 or Upper Egypt, Others) — see
  [`20260911230000_distribution_list_taxonomy.sql`](../supabase/migrations/20260911230000_distribution_list_taxonomy.sql)
  for the full, owner-approved set and why each region match keys on **name and code together**
  (13 field District Managers carry a region name with no region code).
- `head_office` — everyone outside the field force, keyed on an **allowlist of departments**
  (Marketing, Finance, HR, Admins, Executive, QPPV, R&D, SFE, Supply Chain), not on a line —
  three head-office people sit on a sales line's `line_id` because they own that line's brand,
  which is deliberate, not a data error.
- `sato_pharma_family` — the whole company. Seeded **disabled**, and it stays that way: it's the
  only list that can reach everyone at once, and the standing rule (`AGENTS.md` §4, "never fire
  bulk emails") means it stays off until there's a specific, approved use for it. A switched-off
  list is not offered in the composer at all.

Two lists have been retired rather than left on the screen looking like a chosen audience nothing
actually read:

- `sales_managers` — seeded speculatively, never wired to a sender
  ([`20260911180000_drop_unused_sales_managers_list.sql`](../supabase/migrations/20260911180000_drop_unused_sales_managers_list.sql)).
- `closing_fixed_cc` — held the Monthly Closing publish's fixed Cc roles for one day, dropped by
  [`20260912070000_sato_email_composer.sql`](../supabase/migrations/20260912070000_sato_email_composer.sql)
  when the lists became the composer's alone. **Nobody's Cc changed**: the publish reads the same
  three roles (CEO, Marketing Manager, SFE Manager) from `FIXED_CC_ROLES` in
  [closing-publish-recipients.ts](../src/lib/sales/closing-publish-recipients.ts) again.

## Adding a new list

1. Create it from `/admin/distribution-lists` (or a migration, for a list that should exist in
   every environment) and leave it **disabled** until its resolved membership on the admin screen
   matches what you expect.
2. Switch it `enabled`. It then appears in the composer for both seats.
3. That is the whole wiring. **Do not wire a sender to it** — see the box at the top of this file.
   If the owner asks for an automated email to read a list, that is a new decision from him, and
   the pinning test is what will stop it happening by accident in the meantime.
