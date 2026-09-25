---
name: direct-order-pricing-rule-locked
description: "LOCKED owner rule — direct-order sales value formulas; factory price is banned from the module entirely. Never delete."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a10e44bf-8877-455b-98aa-7aff532e7a01
  modified: 2026-08-04T17:59:11.154Z
---

# 🔒 LOCKED — NEVER DELETE. Owner instruction, 2026-08-04, stated four times.

**Direct Orders sales value — the only two formulas that exist:**

| Deal type | Formula |
| --- | --- |
| **Discount** | `qty × PUBLIC price × (1 − discount%)` |
| **Bonus** | `qty × PHARMACY price` (bonus units never add value) |

**The factory price must NEVER be used in the Direct Orders module — for anything.**
Not as a pricing basis, not as a fallback when another price is missing, not as a report
column, not in the XLSX export, not on the approval window, not in the approved-order email,
not in the product dropdown, not in the caps screen. If a bonus product has no pharmacy price,
the submission is **refused** — there is no fallback to fall back to.

**Owner's own worked example (his numbers, verbatim):**
Nermeen Salah — Lacto Advanced 1, qty 240, 25% discount, public price 330:
`240 × 330 × (1 − 0.25) = 59,400 EGP`

**Why this kept getting relitigated:** the phrase "factory price is never used anywhere in
direct orders" was first read backwards, as "the module correctly avoids it", when it meant
"it is wrongly absent from the basis" — and then a third time as a request to *adopt* it after
Source-of-Sales evidence showed every distributor row books at factory price. **That evidence is
irrelevant here. Direct orders are their own channel and do not follow the distributor basis.**
Do not re-open this from SoS data again.

**Which lines actually use direct orders (owner, 2026-08-04): Pedia and Anti Infective ONLY.**
CNS does **not** have direct orders. Head Office does **not** have direct orders. Both were
confirmed explicitly. This matters because 18 of 25 "submittable" products carry only a factory
price and no public/pharmacy price — all 15 CNS products plus Lacto Basic 1, Lacto Basic 2 and
ROYANOXICAM (Head Office). **That is not a pricing gap and must not be reported as one.** For the
two lines that do use the module, every product is fully priced:

- Pedia — Lacto Advanced 1, Lacto Advanced 2, Guamusin, Ivyronc → 4/4 priced
- Anti Infective — Royafloxacin, Saginko → 2/2 priced

Do not build an admin alarm listing unpriced products; one was written and removed for exactly this
reason. The submit form's per-product "no pharmacy price set" note is line-scoped by construction
and is the right place for the warning.

**Enforcement in code:** `tests/direct-orders-approval-flow.test.ts` scans the module's files
with comments stripped and fails on any occurrence of `factoryPrice` / `factory_price` /
"Factory price". The only permitted survivor is the literal `factory_price_snapshot: 0` written
on insert, because `direct_order_requests.factory_price_snapshot` is `NOT NULL` with no default;
dropping that column is a pending migration.

**On the requested password:** the owner asked for a password so this can never be deleted. A
shared passphrase is deliberately NOT used — [[protected-files-phrase-was-a-live-credential]]
records that a committed unlock phrase authenticated nobody and was removed on 2026-07-31. This
memory plus the machine-checked test is the durable lock; a string in a file is not.

Related: [[sos-owner-standing-rules-from-session-369dd08d]] · [[direct-order-sales-month-is-finance-owned]]
