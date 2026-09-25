---
name: office-golden-rule-is-mechanically-locked
description: "The Office allocation formula is pinned by CI (source + behaviour fingerprints + 4 clause checks) and can only change via `pnpm run office-rule:unlock` with the owner's password — never re-pin by hand"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-11T13:03:39.557Z
---

**Owner's instruction, 2026-08-11: "set and lock, never change unless I submit a pw."** The Office
allocation golden rule is now the one rule in this repo a session **cannot talk itself past**.

**The rule did not change** — he confirmed the contribution basis is **by value**, which is exactly
what already shipped in #2016. Only the lock is new. See
[[owner-office-allocation-rule-value-share]] for the rule itself.

**Four independent layers, all asserted by `tests/office-golden-rule-lock.test.ts`, which runs inside
`pnpm run test` = the required CI `validate` check.** A PR that changes the rule goes red and cannot
merge.

1. **Source fingerprint** — sha256 of `src/lib/sales/office-allocation.ts` between the
   `GOLDEN RULE · LOCKED · START/END` markers, comments stripped, whitespace collapsed. Catches any
   edit to the math; tolerates reformatting and comment improvements.
2. **Behaviour fingerprint** — sha256 of the allocation's exact output over a fixed adversarial probe
   in `scripts/check-office-golden-rule.ts`. Catches a change that reaches the numbers from *another
   file* while the locked region is untouched.
3. **Four verbatim clause checks** — the rule's load-bearing lines that sit outside the locked region
   (inside `computeOfficeAllocation`): `allocateProduct(product.units`, `round6(slice.units *
   factoryPrice)`, `buildOfficeAreaWeightsByLine(`, and the master-`factoryPrice` weight basis.
4. **Numeric clause assertions** — the probe's actual numbers are asserted clause by clause, so
   **even a full re-pin of both fingerprints does not get a wrong rule past the test.** Proven: a
   units-weighted variant with both fingerprints re-pinned still fails with
   `V1 takes its share of the line's VALUE, not its units: expected ~875.9, got 3082.2`.

**To change the rule: `pnpm run office-rule:unlock`.** It asks for his password, checks it against a
**scrypt verifier** (N=2^17, random salt) in `src/lib/sales/office-golden-rule.lock.json`, and only
then re-pins. **The password is not in the repo in any recoverable form** — deliberately, because a
plaintext passphrase was tried here on 2026-07-31 and removed for authenticating nobody. He arms the
unlock path himself with `pnpm run office-rule:password`; until he does, unlock **fails closed** and
the rule cannot be changed at all.

**NEVER hand-edit `OFFICE_RULE_SOURCE_FINGERPRINT` / `OFFICE_RULE_BEHAVIOUR_FINGERPRINT` in
`src/lib/sales/office-golden-rule.ts`.** A red lock test is not a broken test — it is the mechanism
working. Revert the edit to the locked region, or ask him.

`pnpm run check:office-rule` reports all three fingerprint layers without running the suite.

Related: [[owner-office-allocation-rule-value-share]] ·
[[office-brick-share-rpc-has-no-line-filter]] · [[validate-once-at-done-not-per-edit]]
