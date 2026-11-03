import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canPlanMarketingDoubleVisit,
  findMarketingDoubleVisitPartner,
  isMarketingDoubleVisit,
  MARKETING_DOUBLE_VISIT_TITLE,
  marketingDoubleVisitPartners,
} from "../src/lib/weekly-planning/marketing-double-visit.ts";

/**
 * Marketing Double Visit on the weekly plan (owner request, 2026-09-14).
 *
 * A Product Manager or Group Product Manager picks "Marketing Double Visit", then a region, then an
 * area, then the colleague they are going with — any active Product Manager, Group Product Manager
 * or Marketing Manager, but never themselves. It is stored like Coaching (type "Other", fixed
 * title) with the partner's name in `attendees`, so it never reaches the readers that treat
 * `double_visit_medical_rep_*` as a Medical Rep.
 */
export function runMarketingDoubleVisitTests() {
  // 1. Offered to PM and GPM only.
  assert.equal(canPlanMarketingDoubleVisit("Product Manager"), true);
  assert.equal(canPlanMarketingDoubleVisit("Group Product Manager"), true);
  assert.equal(canPlanMarketingDoubleVisit("Marketing Manager"), false, "the Marketing Manager is a partner, not offered the option");
  assert.equal(canPlanMarketingDoubleVisit("District Manager"), false);
  assert.equal(canPlanMarketingDoubleVisit("Medical Representative"), false);
  assert.equal(canPlanMarketingDoubleVisit(null, "Group Product Manager"), true, "the app role is enough when the title is blank");

  // 2. The partner list: PM, GPM, Marketing Manager — and the owner is never in it.
  const roster = [
    { fullName: "Rasha Owner", hrId: "B-901", jobTitle: "Product Manager" },
    { fullName: "Mona Product", hrId: "B-902", jobTitle: "Product Manager" },
    { fullName: "Hany Group", hrId: "B-903", jobTitle: "Group Product Manager" },
    { fullName: "Amr Marketing", hrId: "B-904", jobTitle: "Marketing Manager" },
    { fullName: "Sara Rep", hrId: "B-905", jobTitle: "Medical Representative" },
    { fullName: "Omar Trainer", hrId: "B-906", jobTitle: "Training Manager" },
    { fullName: "Nour District", hrId: "B-907", jobTitle: "District Manager" },
  ];
  const partners = marketingDoubleVisitPartners(roster, " b-901 ");
  assert.deepEqual(
    partners.map((partner) => partner.fullName),
    ["Amr Marketing", "Hany Group", "Mona Product"],
    "exactly the marketing colleagues, sorted, with the submitter removed",
  );
  assert.equal(
    partners.some((partner) => partner.fullName === "Rasha Owner"),
    false,
    "the submitter must never be offered herself",
  );

  // 3. A stored name resolves back to its partner, ignoring case and spacing; the owner never does.
  assert.equal(findMarketingDoubleVisitPartner(partners, "  hany   GROUP ")?.hrId, "B-903");
  assert.equal(findMarketingDoubleVisitPartner(partners, "Rasha Owner"), null);
  assert.equal(findMarketingDoubleVisitPartner(partners, ""), null);

  // A name two partners share is refused, because the plan stores whoever it resolves to. Each one
  // is still found by the legal name a saved plan holds.
  const sharedName = [
    { fullName: "Aya Mohamed", hrId: "B-911", jobTitle: null, legalName: "Aya Mohamed Ali" },
    { fullName: "Aya Mohamed", hrId: "B-912", jobTitle: null, legalName: "Aya Mohamed Salem" },
  ];
  assert.equal(findMarketingDoubleVisitPartner(sharedName, "Aya Mohamed"), null);
  assert.equal(findMarketingDoubleVisitPartner(sharedName, "Aya Mohamed Salem")?.hrId, "B-912");

  // 4. Recognised the way it is stored, and never confused with Coaching or a rep Double Visit.
  assert.equal(isMarketingDoubleVisit("Other", MARKETING_DOUBLE_VISIT_TITLE), true);
  assert.equal(isMarketingDoubleVisit(MARKETING_DOUBLE_VISIT_TITLE, ""), true);
  assert.equal(isMarketingDoubleVisit("Other", "Coaching"), false);
  assert.equal(isMarketingDoubleVisit("Double Visit", "Double Visit"), false);

  // 5. The service stores it as "Other" with the partner in attendees, and refuses a submit without
  //    a valid partner or from someone who is not offered the option.
  const serviceSrc = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  assert.match(serviceSrc, /if \(value === MARKETING_DOUBLE_VISIT_TITLE\) return "Other";/);
  assert.match(serviceSrc, /if \(options\.submit && !context\?\.allowed\)/);
  assert.match(serviceSrc, /if \(options\.submit && !partner\)/);
  assert.match(serviceSrc, /const requiresRep = activityRequiresRep\(activityType, isCoaching\);/,
    "a Marketing Double Visit must never require a Medical Rep");
  const saveCalls = serviceSrc.match(/marketingDoubleVisit: await marketingDoubleVisitContextFor\(/g) ?? [];
  assert.equal(saveCalls.length, 3, "create, revise and edit all pass the partner list to the submit check");

  // 6. The builder offers it only where the server does, and shows the partner picker.
  const workspaceSrc = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  assert.match(workspaceSrc, /planningActivityOptionsFor\(\s*workspace\.canPlanMarketingDoubleVisit/);
  assert.match(workspaceSrc, /<MarketingPartnerSelect/);
}
