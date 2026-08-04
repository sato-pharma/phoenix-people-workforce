/**
 * Shared CRM (iReports360) row + identity types. Pure types only — no runtime deps — so this
 * is the canonical home other domains can import from without pulling in server code.
 */

/** Admin resolution for a CRM identity that never auto-maps: mapped (apply a specific hr_id),
 * resigned (hide, leave unmapped), or pending (default, keep showing). Structurally identical
 * to visits-report's `UnmappedCrmResolutionAction`. */
export type CrmResolutionAction = "mapped" | "pending" | "resigned";

/** One stored admin identity-resolution decision. */
export type CrmResolutionRow = {
  crmId: number;
  /** The CRM display label ("First.Last ( Area / Line )") this decision was made AGAINST, as
   * stored on the resolution row. Optional so older constructors still type-check; when present
   * on a "mapped" row it scopes the override to records carrying that label — a CRM slot handed
   * to a NEW person after the mapping must not inherit it (slots 1102/1395/1399 all carry two
   * different people's names in their production history). */
  crmName?: string | null;
  mappedHrId: string | null;
  status: CrmResolutionAction;
};

/** One manual-override entry: the admin-mapped hr id plus the normalized CRM label the mapping
 * was recorded against (null on legacy rows saved before labels were stored — those apply
 * unconditionally, the pre-label behavior). */
export type CrmManualOverride = { hrId: string; label: string | null };

/** The crm_id/crm_username/manual-override lookup maps used by the identity waterfall. */
export type CrmIdentityMaps = {
  hrIdByCrmId: Map<string, string>;
  hrIdByCrmUsername: Map<string, string>;
  hrIdByManualOverride: Map<string, CrmManualOverride>;
  /** `hr_id` -> `last_working_date` (YYYY-MM-DD) for everyone who has one. Feeds the post-exit
   * attribution guard: work dated after someone left cannot be theirs. Only employees WITH a last
   * working date appear, so an active employee is simply absent. */
  lastWorkingDateByHrId: Map<string, string>;
  /** `hr_id` -> that employee's OWN normalized `crm_username`. The reverse of `hrIdByCrmUsername`,
   * and deliberately NOT deduplicated: this answers "what does this specific person's CRM label look
   * like", so an ambiguous label shared by two employees still belongs to each of them. Used by the
   * post-exit guard to tell a handed-over slot from someone's own trailing work. */
  crmUsernameByHrId: Map<string, string>;
};

/** A full `ireports360_visits` row (every persisted column). Reads that project a subset of
 * columns should pass their own narrower row type as the `queryVisits` generic; this default
 * describes a `select("*")`. */
export type CrmVisitRow = {
  id: string;
  crm_visit_id: number;
  agent_crm_id: number;
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  attendance: number | null;
  call_type: number | null;
  comment: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_contact_grade: string | null;
  crm_region_id: number | null;
  crm_region_name: string | null;
  crm_save_date: string | null;
  customer_name: string | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  speciality: string | null;
  visit_date: string;
  visit_date_time: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  raw_payload: Record<string, unknown> | null;
  synced_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** A full `ireports360_checkins` row (every persisted column). Same subset-projection note as
 * `CrmVisitRow`. */
export type CrmCheckinRow = {
  id: string;
  crm_checkin_id: number;
  agent_crm_id: number;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  lat: number | null;
  lon: number | null;
  address: string | null;
  check_date: string;
  raw_payload: Record<string, unknown> | null;
  synced_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};
