// =============================================================================
// File every existing candidate in the new workspace's tabs (owner, 2026-10-20 rebuild, Phase 5)
// =============================================================================
// The workspace files people by their OWN replies, never by their CV (owner: "we folder based on
// whatsapp replies"). New applicants are filed as they answer; this files the people already in the
// pool, once.
//
// THE ROLE, in order — the first one found decides:
//   1. the role family already on the candidate (`declared_role_family`);
//   2. their WhatsApp tap: the newest conversation that holds a role and reaches this person by one of
//      the three SAFE links (src/lib/recruitment/inbound/whatsapp-session-link.ts) — never a
//      forwarder's number;
//   2b. their OWN earlier reply (owner, 2026-10-20, after the WhatsApp inbox audit): a conversation
//      from before 11 Oct, still linked to the record the 18 Oct clean-up removed, whose number is
//      this candidate's own phone and no other live candidate's — the row says so;
//   3. the careers-form role: a candidate who came in through the website and whose job title is
//      exactly one of the careers roles.
// THE PLACE: their region and area reply (on the candidate, else in that same conversation), the
// area matched against the AU directory.
//
// NEEDS PLACING, never a guess, for anyone uncertain: no reply at all; the retired Human Resources
// tap (neither HR tab is a safe guess); a Medical Rep area that matches nothing in AU. Somebody HR has
// already filed by hand keeps that filing and is not touched.
//
// Also written: the role family, onto any candidate who lacked it, from the tap or the form — what
// the Talent Acquisition fence and the completeness count both read. Then the stored completeness is
// recomputed for everyone. The apply ends by PROVING the totals: placed + Needs placing = everyone.
//
// Run AFTER scripts/recruitment/recover-unfinished-whatsapp-answers.ts, so the answers it recovers
// are what files people.
//
// Usage (from the primary checkout; the dry run writes nothing but the pre-image workbook in xlsx/):
//   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/alias-loader.mjs scripts/recruitment/place-existing-candidates.ts
// Apply (production only; N is the plan size the dry run just printed):
//   ... scripts/recruitment/place-existing-candidates.ts --apply --confirm-production=<N>
// Idempotent: a placement is one row per person and tab, upserted.
// =============================================================================

import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { recruitmentDb } from "@/lib/recruitment/db";
import { sessionAreaLabel } from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { SESSION_COLUMNS, type SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import { linkSessionsToCandidates, readEveryPage } from "@/lib/recruitment/inbound/whatsapp-session-link";
import { resolveWebsiteApplyRole, websiteApplyRoleKeys } from "@/lib/recruitment/inbound/website-apply";
import { recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { placementFromReply } from "@/lib/recruitment/workspace/placement-from-reply";
import { listPlacementsFor, placeFromAnswers, resolveAuArea } from "@/lib/recruitment/workspace/placements-db";
import { roleTabForFamily, type WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";
import { assertConfirmed, assertProductionTarget, isBlank, parseScriptOptions, writePreImage } from "./lib/script-kit.ts";

refuseUnknownFlags({
  name: "place-existing-candidates",
  entry: import.meta.url,
  known: ["--apply", "--dry-run", "--confirm-production"],
});

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";

type CandidateRow = {
  id: string;
  full_name: string | null;
  phone_norm: string | null;
  declared_role_family: string | null;
  applied_for_job_title: string | null;
  preferred_region_code: string | null;
  preferred_area_name: string | null;
};

type TapSession = SessionRow & { updated_at: string | null; started_at: string | null };

/** "07 Oct 2026", Cairo. */
function cairoDay(iso: string | null): string {
  if (!iso) return "an earlier date";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date(iso));
}

type RoleSource = "on the candidate" | "WhatsApp reply" | "careers form" | "none";

type Decision = {
  candidate: CandidateRow;
  roleFamily: string | null;
  roleSource: RoleSource;
  regionCode: string | null;
  areaName: string | null;
  session: TapSession | null;
  tab: WorkspaceRoleTab | null;
  why: string;
  /** Write `declared_role_family`: the candidate lacked it and the tap or the form gave one. */
  writeFamily: boolean;
  /** HR filed them by hand: kept as it is. */
  hrFiled: boolean;
};

function tabLabel(tab: WorkspaceRoleTab | null): string {
  const labels: Record<WorkspaceRoleTab, string> = {
    district_manager: "District Manager",
    hr_section_head: "HR Section Head",
    medical_rep: "Medical Rep",
    office_coordinator: "Office Coordinator",
    other: "Other",
    personnel: "Personnel",
    product_manager: "Product Manager",
    rm_am_nsm: "RM / AM / NSM",
    talent_acquisition: "Talent Acquisition",
  };
  return tab ? labels[tab] : "Needs placing";
}

async function main() {
  const options = parseScriptOptions(process.argv.slice(2));
  assertProductionTarget();
  const db = recruitmentDb();

  const candidates = await readEveryPage<CandidateRow>("Candidates", (from, to) =>
    db
      .from("ats_candidates")
      .select("id,full_name,phone_norm,declared_role_family,applied_for_job_title,preferred_region_code,preferred_area_name")
      .order("id", { ascending: true })
      .range(from, to),
  );
  const ids = candidates.map((row) => row.id);
  const placements = await listPlacementsFor(ids);

  // 2. WhatsApp taps, by the safe links, newest first.
  const sessions = (
    await readEveryPage<TapSession>("WhatsApp conversations", (from, to) =>
      db.from(SESSIONS_TABLE).select(`${SESSION_COLUMNS},updated_at,started_at`).order("id", { ascending: true }).range(from, to),
    )
  ).filter((row) => Boolean(row.job_title_family));
  const links = await linkSessionsToCandidates(sessions);
  const tapByCandidate = new Map<string, TapSession>();
  for (const session of sessions.sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""))) {
    const candidateId = links.get(session.id);
    if (candidateId && !tapByCandidate.has(candidateId)) tapByCandidate.set(candidateId, session);
  }

  // 2b. Their OWN earlier reply (owner, 2026-10-20, after the WhatsApp inbox audit: "Yes, use the old
  // answer"). Someone who answered the bot before 11 Oct, whose record the 18 Oct clean-up removed,
  // and who applied again since, has their role only in that old conversation — still linked to the
  // removed record, so no safe link reaches it. It files them when the conversation's number IS the
  // candidate's own phone and NO other live candidate holds that number. A conversation still linked
  // to a live candidate belongs to that person, and a shared number is never guessed.
  const liveIds = new Set(ids);
  const liveOnNumber = new Map<string, CandidateRow[]>();
  for (const candidate of candidates) {
    if (isBlank(candidate.phone_norm)) continue;
    const key = (candidate.phone_norm as string).trim();
    liveOnNumber.set(key, [...(liveOnNumber.get(key) ?? []), candidate]);
  }
  const earlierReplyByCandidate = new Map<string, TapSession>();
  for (const session of sessions) {
    if (!session.applied_candidate_id || liveIds.has(session.applied_candidate_id)) continue;
    const owners = liveOnNumber.get(session.wa_id) ?? [];
    if (owners.length !== 1 || tapByCandidate.has(owners[0].id) || earlierReplyByCandidate.has(owners[0].id)) continue;
    earlierReplyByCandidate.set(owners[0].id, session);
  }

  // 3. Careers-form roles: a website candidate whose job title is exactly a careers role.
  const websiteIds = new Set(
    (
      await readEveryPage<{ id: string; candidate_id: string | null }>("Website applications", (from, to) =>
        db
          .from("ats_cv_intake_events")
          .select("id,candidate_id")
          .eq("channel", "website")
          .not("candidate_id", "is", null)
          .order("id", { ascending: true })
          .range(from, to),
      )
    ).map((row) => row.candidate_id as string),
  );
  const familyByCareersTitle = new Map<string, string>();
  for (const key of websiteApplyRoleKeys()) {
    const role = resolveWebsiteApplyRole(key);
    if (role) familyByCareersTitle.set(role.jobTitle.trim().toLowerCase(), role.roleFamily);
  }

  const decisions: Decision[] = [];
  for (const candidate of candidates) {
    const held = placements.get(candidate.id) ?? [];
    const earlier = tapByCandidate.has(candidate.id) ? null : earlierReplyByCandidate.get(candidate.id) ?? null;
    const session = tapByCandidate.get(candidate.id) ?? earlier;
    let roleFamily: string | null = null;
    let roleSource: RoleSource = "none";
    if (!isBlank(candidate.declared_role_family)) {
      roleFamily = (candidate.declared_role_family as string).trim();
      roleSource = "on the candidate";
    } else if (session?.job_title_family) {
      roleFamily = session.job_title_family;
      roleSource = "WhatsApp reply";
    } else if (websiteIds.has(candidate.id) && candidate.applied_for_job_title) {
      roleFamily = familyByCareersTitle.get(candidate.applied_for_job_title.trim().toLowerCase()) ?? null;
      if (roleFamily) roleSource = "careers form";
    }
    const regionCode = !isBlank(candidate.preferred_region_code) ? candidate.preferred_region_code : session?.region_code ?? null;
    const areaName = !isBlank(candidate.preferred_area_name) ? candidate.preferred_area_name : session ? sessionAreaLabel(session) : null;
    const writeFamily = roleSource === "WhatsApp reply" || roleSource === "careers form";

    if (held.some((row) => row.placedBy === "hr")) {
      const tab = held.find((row) => row.placedBy === "hr")?.roleTab ?? null;
      decisions.push({ areaName, candidate, hrFiled: true, regionCode, roleFamily, roleSource, session, tab, why: "Filed by HR by hand: kept", writeFamily });
      continue;
    }

    let tab: WorkspaceRoleTab | null = null;
    let why = "";
    const sharers = isBlank(candidate.phone_norm)
      ? []
      : (liveOnNumber.get((candidate.phone_norm as string).trim()) ?? []).filter((other) => other.id !== candidate.id);
    if (!roleFamily && sharers.length > 0) {
      // Not "no reply": the number answered, but it is shared with another record, and different
      // names on one number may be different people. The duplicate badge and Merge settle it.
      why = `Shares a WhatsApp number with ${sharers.map((other) => other.full_name ?? "another record").join(", ")}: merge the two, or place by hand`;
    } else if (!roleFamily) {
      why = "No WhatsApp reply and no careers-form role";
    } else if (roleFamily === "human_resources") {
      why = "The retired Human Resources tap: neither HR tab is a safe guess";
    } else if (!roleTabForFamily(roleFamily)) {
      why = "This role fits no tab";
    } else {
      const area = await resolveAuArea(areaName);
      const placement = placementFromReply({
        areaCode: area?.areaCode ?? null,
        areaName: area?.areaName ?? areaName ?? null,
        areaSalesRegionCode: area?.salesRegionCode ?? null,
        regionCode,
        roleFamily,
      });
      if (placement) {
        tab = placement.roleTab;
        why =
          earlier && roleSource === "WhatsApp reply"
            ? `From their own WhatsApp reply of ${cairoDay(earlier.started_at)}, given before 11 Oct on the record removed on 18 Oct`
            : `From the ${roleSource}`;
      } else {
        why = `The area "${areaName}" matches nothing in the AU directory`;
      }
    }
    decisions.push({ areaName, candidate, hrFiled: false, regionCode, roleFamily, roleSource, session, tab, why, writeFamily });
  }

  const toPlace = decisions.filter((decision) => !decision.hrFiled && decision.tab);
  const toWriteFamily = decisions.filter((decision) => decision.writeFamily);
  const planSize = toPlace.length + toWriteFamily.length;

  const preImage = await writePreImage("place-existing-candidates", options.mode, [
    {
      columns: [
        { header: "Candidate", key: "candidate", width: 28 },
        { header: "Role", key: "role", width: 24 },
        { header: "Where the role came from", key: "source", width: 22 },
        { header: "Region", key: "region", width: 16 },
        { header: "Area", key: "area", width: 22 },
        { header: "Tab now", key: "now", width: 26 },
        { header: "Tab after", key: "tab", width: 20 },
        { header: "Why", key: "why", width: 48 },
      ],
      name: "Who goes where",
      rows: decisions.map((decision) => ({
        area: decision.areaName ?? "",
        candidate: decision.candidate.full_name ?? "(no name)",
        now: (placements.get(decision.candidate.id) ?? []).map((row) => tabLabel(row.roleTab)).join(", ") || "Needs placing",
        region: decision.regionCode ? (candidateRegionLabels[decision.regionCode as CandidateRegionCode] ?? decision.regionCode) : "",
        role: decision.roleFamily ? (candidateRoleFamilyLabels[decision.roleFamily as CandidateRoleFamily] ?? decision.roleFamily) : "",
        source: decision.roleSource,
        tab: tabLabel(decision.tab),
        why: decision.why,
      })),
    },
  ]);

  const byTab = new Map<string, number>();
  for (const decision of decisions) byTab.set(tabLabel(decision.tab), (byTab.get(tabLabel(decision.tab)) ?? 0) + 1);
  const summary = {
    candidates: candidates.length,
    familiesToWrite: toWriteFamily.length,
    planSize,
    preImage,
    toPlace: toPlace.length,
    willBe: Object.fromEntries(byTab),
  };

  if (options.mode === "dry-run") {
    console.log(JSON.stringify({ ...summary, mode: "dry-run", status: "dry_run_ok" }, null, 2));
    return;
  }
  if (planSize === 0) {
    console.log(JSON.stringify({ ...summary, mode: "apply", status: "apply_ok_nothing_to_do" }, null, 2));
    return;
  }
  assertConfirmed(options, planSize);

  const failures: { candidate: string; error: string }[] = [];
  for (const decision of toWriteFamily) {
    const { error } = await db
      .from("ats_candidates")
      .update({ declared_role_family: decision.roleFamily })
      .eq("id", decision.candidate.id)
      .is("declared_role_family", null);
    if (error) failures.push({ candidate: decision.candidate.full_name ?? decision.candidate.id, error: error.message });
  }
  for (const decision of toPlace) {
    const result = await placeFromAnswers({
      areaName: decision.areaName,
      candidateId: decision.candidate.id,
      placedBy: "migration",
      regionCode: decision.regionCode,
      roleFamily: decision.roleFamily,
    });
    if (result.outcome !== "placed") {
      failures.push({
        candidate: decision.candidate.full_name ?? decision.candidate.id,
        error: result.outcome === "failed" ? result.message : "Not placed on apply",
      });
    }
  }
  await recomputeCompleteness(ids);

  // The proof: everyone is either filed in a tab or in Needs placing, and nobody twice by accident.
  const after = await listPlacementsFor(ids);
  const placed = ids.filter((id) => (after.get(id) ?? []).length > 0).length;
  const needsPlacing = ids.length - placed;
  const rowsByTab = new Map<string, number>();
  for (const rows of after.values()) for (const row of rows) rowsByTab.set(tabLabel(row.roleTab), (rowsByTab.get(tabLabel(row.roleTab)) ?? 0) + 1);

  console.log(
    JSON.stringify(
      {
        ...summary,
        failures,
        mode: "apply",
        proof: {
          candidates: ids.length,
          needsPlacing,
          placed,
          placedPlusNeedsPlacing: placed + needsPlacing,
          rowsByTab: Object.fromEntries(rowsByTab),
        },
        status: failures.length > 0 ? "apply_completed_with_failures" : "apply_ok",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
