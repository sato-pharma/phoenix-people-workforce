# Customer master: who owns what, and the one name key

Audit REC-009 (finding F-SAL-010), 14 November 2026.

A customer (a pharmacy, a hospital, a sales customer) is handled in five folders and the Source of Sales customer map. Each folder owns a different job, and each one used to fold names its own way. Because of that, the same pharmacy could fold to different keys on different screens.

## The one name key

`foldCustomerName` in `src/lib/customer-master/name-key.ts` is the one exported matcher for a customer's name. It works like this:

- applies NFKD, and drops Latin accents, Arabic harakat and tatweel;
- folds every alef form to ا, and ى to ي;
- lowercases;
- turns anything else into a space, then collapses the spaces.

It keeps words apart, and it keeps ة and ه apart. `removeCustomerStopWords` and `CUSTOMER_NAME_STOP_WORDS` sit beside it. They drop the generic words ("pharmacy", "new", "doctor", "hospital") from a keyed name, but never down to nothing.

It is the Pharmacy Master fold, moved unchanged. That fold was `normalizeArabicPharmacyName`, which still answers at `src/lib/pharmacy-master/pharmacy-matching.ts` as the very same function, so **no key and no match changed**. The owner chose this on 14 November 2026 ("one home, no merges").

It is read by:

- Pharmacy Master;
- Pharmacy Search (search, locate, profile, save);
- Direct Orders' evidence and geography checks;
- Phoenix CRM's pharmacy rules (`pharmacyNameKey` builds on it).

## The five folders

| Folder | Owns | Name rule |
| --- | --- | --- |
| `src/lib/pharmacy-master/` | Marketing's candidate pairs between pharmacies and distributor codes (Super Admin, CEO) | the one key |
| `src/lib/pharmacy-search/` | Pharmacy Search: Source of Sales customers, the direct-order registers, nearby hospitals | the one key |
| `src/lib/customer-pharmacy-mapping/` | Marketing's links between a sales customer and a marketing pharmacy, and their readiness | no fold of its own |
| `src/lib/customer-identity/` | Suggestions that a CRM doctor or pharmacist is a sales customer | `identityNameKey`: a person's name |
| `src/lib/customer-360/` | Customer 360 pages, export and pharmacy matches, on the closing | `pharmacyNameKey`, built on the one key |
| Source of Sales customer map (`src/lib/sales/customer-mapping.ts`, `src/lib/sales/normalizer/`) | A sales customer's stable master id, and a distributor's aliases | `normalizeIdentityText`, `normalizeAliasKey` |

## The folds that keep their own rule

`CUSTOMER_NAME_FOLDS_THAT_DIFFER` in `name-key.ts` lists every other fold of a customer's name, with who reads it and why it differs. Most of them could not switch without a visible change:

- a stored key would stop matching: the sales master id, the normalizer's aliases, the weekly mappings;
- names a screen now shows apart would merge: the rep's Phoenix CRM list.

The database's own folds are in the same list:

- `phx_normalize_arabic`, used by the direct-order picker;
- `phoenix_crm_fold_name`, mirrored in the browser by Phoenix CRM's `customerNameKey`. That is a different function from `foldCustomerName`, despite the similar name.

## Adding a fold

`tests/customer-name-key.test.ts` refuses a new regex that folds the alef forms anywhere under `src/lib` unless it is sorted. There are three ways to sort it:

- a fold of a customer's name calls `foldCustomerName`;
- a fold that must keep its own rule goes in `CUSTOMER_NAME_FOLDS_THAT_DIFFER`, with its reason;
- a fold of something that is not a customer's name goes in the test's `NOT_A_CUSTOMER_NAME` list. Examples are a town, an address, a weekday or a person's message.

The same test holds the table of sample names that fold to one customer, and the pairs that stay apart.
