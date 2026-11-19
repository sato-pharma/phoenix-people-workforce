-- medical_insurance_policy_50048950
--
-- WHAT THIS CHANGES: the Libano-Suisse policy row becomes the policy as ISSUED (policy number 50048950, policy
--   document MED/6021-3, issued 22 November 2026; the owner shared it on 2026-11-19):
--     * policy_number 50048950 (the proposal code, Rev 1.3, stays beside it);
--     * ends_on 26 November 2027: the schedule's cover runs 22 November 2026 to 26 November 2027, 370 days
--       (clause 5/1 "ثلاثمائة وسبعون يوماً"), renewal on 27 November 2027;
--     * the rate card's rates are the schedule's "Premium per age band group", per person for the term, as
--       printed, every band from 0 to 79 quoted for plans A, B and C. Only 80 and over stays unquoted (the
--       schedule prints no rate for it). The fees are unchanged and match the schedule: 1.55% tax and
--       supervision, EGP 30 a member for the card ("رسوم اصدار", 4,170.00 for 139 people) and EGP 90 once
--       ("رسوم اتساع"). The schedule's total: 139 people, net EGP 927,635.54, tax 14,378.35, total 946,273.89.
--   Nothing else: no member row, no plan, no start day moves, and the age limits stay as they were.
-- WHY: the system prices every person, every joiner's charge, every leaver's refund and the monthly split from
--   this row; it held the offer's rates (with three bands nobody on the register could be priced in) and the
--   offer's end.
-- ROLLBACK: the row as it was is in medical_insurance_backup_20261119.policies_before_issue:
--   update public.medical_insurance_policies p set policy_number = b.policy_number, ends_on = b.ends_on,
--     rate_card = b.rate_card, notes = b.notes
--     from medical_insurance_backup_20261119.policies_before_issue b where b.id = p.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create schema if not exists medical_insurance_backup_20261119;
revoke all on schema medical_insurance_backup_20261119 from public, anon, authenticated;
create table if not exists medical_insurance_backup_20261119.policies_before_issue as
  select id, policy_number, starts_on, ends_on, rate_card, notes from public.medical_insurance_policies;
revoke all on table medical_insurance_backup_20261119.policies_before_issue from public, anon, authenticated;

-- Only the policy that starts on 22 November 2026 (migration 20261119133557) becomes the issued one.
update public.medical_insurance_policies
   set policy_number = '50048950',
       ends_on = date '2027-11-26',
       rate_card = '{
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
        "rates": [7569.75, 8419.61, 10018.72, 12328.77, 14994.33, 17589.83, 21726.51, 24234.84, 31342.82, 39339.30, 46980.38, 54088.44, 62084.83, null]
      },
      "B": {
        "annualLimit": 75000, "network": "Full Network-003", "room": "Shared room",
        "rates": [3494.61, 4052.66, 4776.65, 5822.34, 7028.99, 8203.97, 10076.66, 11212.13, 14429.80, 18049.73, 21508.79, 24726.62, 28346.52, null]
      },
      "C": {
        "annualLimit": 50000, "network": "Full Network-003", "room": "Shared room",
        "rates": [3161.55, 3695.59, 4347.59, 5289.29, 6375.95, 7434.08, 9120.54, 10143.10, 13040.79, 16300.75, 19415.82, 22313.66, 25573.58, null]
      }
    },
    "taxBasisPoints": 155,
    "cardFeePerMember": 30,
    "issueFee": 90,
    "cardReissueFee": 30,
    "lastQuarterAdditionBasisPoints": 2500,
    "ageLimits": { "employee": 64, "spouse": 64, "child": 18 }
  }'::jsonb,
       notes = 'Issued policy 50048950 (MED/6021-3), 22 November 2026 to 26 November 2027, 370 days. Schedule: 139 people, EGP 927,635.54 before tax and fees, EGP 946,273.89 in all. Rates per person for the term, by plan and age band.'
 where insurer = 'Libano-Suisse Takaful Egypt'
   and starts_on = date '2026-11-22';

commit;
