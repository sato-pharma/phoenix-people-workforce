import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { partnerRepName } from "../src/lib/crm/visit-workload.ts";

// A MANAGER'S VISITS IN EXPENSE APPROVALS NAME THE REP HE WAS WITH — EVEN A REP WHO HAS RESIGNED
// (owner, 2026-11-06). The trip evidence listed a manager's joint visits as a bare "· double". On
// production, 3,263 joint visits since June were logged by 50 reps who have since resigned; every one
// still carries the rep's own hr id, none dated before that rep's hire. 90 more carry no hr id because
// iReports360 handed the account to a later hire and relabelled the rows with HIS name — those read
// "Previous holder ( territory )", never the later holder's name.

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

export function runOutstationPartnerRepNameTests() {
  const names = new Map([
    ["mr-0101", "Mona Adel"], // resigned — the directory read is includeInactive
    ["dm-0007", "Karim Fawzy"],
  ]);

  // 1. A partner visit names the rep who logged it, resigned or not, by the row's own hr id.
  assert.equal(
    partnerRepName({ agentHrId: "MR-0101", nameByHrKey: names, role: "partner", vendorLabel: "Someone.Else ( Qena 1 / A )" }),
    "Mona Adel",
    "a joint visit names its rep from the directory by hr id — a resigned rep included, and never the vendor's label over it",
  );
  // 2. An hr id the directory cannot name falls back to the door's own name for that row.
  assert.equal(
    partnerRepName({ agentHrId: "MR-9999", nameByHrKey: names, role: "partner", vendorLabel: "  Hala Samir  " }),
    "Hala Samir",
  );
  // 3. The person's own visit names nobody — there is no rep beside him.
  assert.equal(partnerRepName({ agentHrId: "DM-0007", nameByHrKey: names, role: "agent", vendorLabel: "Karim Fawzy" }), null);
  // 4. No hr id: the vendor label may be the account's LATER holder, so it is never taken here.
  assert.equal(
    partnerRepName({ agentHrId: null, nameByHrKey: names, role: "partner", vendorLabel: "Osama.Ali ( Qena 1 / A )" }),
    null,
    "a row with no hr id is never named from the vendor label directly — the hire-date check decides it",
  );

  // 5. The read decides those rows against hire dates, and the check-in borrowed from a rep wears the
  // same name as the visit it came from.
  const read = source("../src/lib/crm/visit-workload.ts");
  assert.match(read, /isHandedOverLabel\(\s*\{ crmId: pending\.crmId/, "a no-hr-id partner visit is tested against hire dates");
  assert.match(read, /handedOver \? previousHolderLabel\(pending\.label\) : pending\.label/);
  assert.match(read, /via: owner === selfKey \? null : repNameByDayOwner\.get\(`\$\{day\}\|\$\{owner\}`\)/);
  assert.match(read, /"agent_crm_id, agent_hr_id, agent_name, ampm,/, "the read selects the door's agent_name");

  // 6. The approvals panel prints it beside the visit.
  const panel = source("../src/components/outstation/trip-workload-evidence.tsx");
  assert.match(panel, /visit\.repName \? \(\s*<>\s*\{" · double with "\}\s*<span[^>]*>\{visit\.repName\}<\/span>/);
}
