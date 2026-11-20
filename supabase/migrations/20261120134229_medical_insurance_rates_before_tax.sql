-- medical_insurance_rates_before_tax
--
-- WHAT THIS CHANGES: the rate card of policy 50048950 holds each band's premium BEFORE the 1.55% tax, and says
--   the premium is paid in four quarterly instalments.
--     * rates: the schedule's printed "Premium per age band group" divided by 1.0155, to the piastre. Every one of
--       the 39 rates goes back to the printed figure when the 1.55% is added (A 55 to 59: 30,864.42 + 1.55% =
--       31,342.82). 80 and over stays unquoted.
--     * premiumInstalments 4 (the policy's "Mode of Payment: Quarterly").
--   Nothing else: the fees, the age limits, the dates and every member stay as they are.
-- WHY: Libano-Suisse's first invoice (INV6021-2026-1, 22 November 2026 to 21 February 2027) and its "Initial
--   Breakdown" (shared by the owner on 2026-11-20) show the printed rates already carry the tax: each person's year
--   on the breakdown is the printed rate, and the 139 together come to 942,012.93, the schedule's net 927,635.54
--   plus its tax 14,378.35. Migration 20261119150524 stored the printed rates and the code added 1.55% on top, so
--   every cost on the tab was 1.55% too high. With these rates the same 139 come to 927,635.51 before tax, tax
--   14,378.35, and the first quarter to 235,503.47 plus the 4,260 cards and issue fee (the invoice: 239,763.75).
-- ROLLBACK: the row as it was is in medical_insurance_backup_20261120.policies_before_net_rates:
--   update public.medical_insurance_policies p set rate_card = b.rate_card
--     from medical_insurance_backup_20261120.policies_before_net_rates b where b.id = p.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create schema if not exists medical_insurance_backup_20261120;
revoke all on schema medical_insurance_backup_20261120 from public, anon, authenticated;
create table if not exists medical_insurance_backup_20261120.policies_before_net_rates as
  select id, policy_number, starts_on, ends_on, rate_card from public.medical_insurance_policies;
revoke all on table medical_insurance_backup_20261120.policies_before_net_rates from public, anon, authenticated;

-- Only the issued policy (migration 20261119150524) changes.
update public.medical_insurance_policies
   set rate_card = '{
    "currency": "EGP",
    "ageBands": [
      { "from": 0, "to": 17 }, { "from": 18, "to": 24 }, { "from": 25, "to": 29 }, { "from": 30, "to": 34 },
      { "from": 35, "to": 39 }, { "from": 40, "to": 44 }, { "from": 45, "to": 49 }, { "from": 50, "to": 54 },
      { "from": 55, "to": 59 }, { "from": 60, "to": 64 }, { "from": 65, "to": 69 }, { "from": 70, "to": 74 },
      { "from": 75, "to": 79 }, { "from": 80, "to": null }
    ],
    "plans": {
      "A": {
        "annualLimit": 150000, "network": "Full Network-004", "room": "Single room",
        "rates": [7454.21, 8291.10, 9865.80, 12140.59, 14765.47, 17321.35, 21394.89, 23864.93, 30864.42, 38738.85, 46263.30, 53262.87, 61137.20, null]
      },
      "B": {
        "annualLimit": 75000, "network": "Full Network-003", "room": "Shared room",
        "rates": [3441.27, 3990.80, 4703.74, 5733.47, 6921.70, 8078.75, 9922.86, 11040.99, 14209.55, 17774.23, 21180.49, 24349.21, 27913.86, null]
      },
      "C": {
        "annualLimit": 50000, "network": "Full Network-003", "room": "Shared room",
        "rates": [3113.29, 3639.18, 4281.23, 5208.56, 6278.63, 7320.61, 8981.33, 9988.28, 12841.74, 16051.94, 19119.47, 21973.08, 25183.24, null]
      }
    },
    "taxBasisPoints": 155,
    "cardFeePerMember": 30,
    "issueFee": 90,
    "cardReissueFee": 30,
    "lastQuarterAdditionBasisPoints": 2500,
    "premiumInstalments": 4,
    "ageLimits": { "employee": 64, "spouse": 64, "child": 18 }
  }'::jsonb
 where insurer = 'Libano-Suisse Takaful Egypt'
   and policy_number = '50048950';

commit;
