export type CrmIntegrityContactMatchState = "exact_contact_match" | "nearest_different_contact" | "no_checkin";

export type CrmIntegritySaveLagFlag = "same_day" | "next_day_or_later";

export type CrmIntegritySpeedFeasibilityFlag = "ok" | "impossible_speed" | "unknown";

export type CrmIntegrityRow = {
  agentCrmId: number;
  agentHrId: string | null;
  agentName: string | null;
  // Matched check-in (null when contactMatchState === "no_checkin").
  checkinAddress: string | null;
  checkinContactCrmId: number | null;
  checkinContactName: string | null;
  checkinDate: string | null;
  checkinLat: number | null;
  checkinLon: number | null;
  comment: string | null;
  contactMatchState: CrmIntegrityContactMatchState;
  contactName: string | null;
  crmSaveDate: string | null;
  crmVisitId: number;
  customerName: string | null;
  distanceFromPreviousCheckinKm: number | null;
  id: string;
  impliedSpeedKmh: number | null;
  saveLagFlag: CrmIntegritySaveLagFlag | null;
  saveLagHours: number | null;
  speedFeasibilityFlag: CrmIntegritySpeedFeasibilityFlag | null;
  visitContactCrmId: number | null;
  visitDate: string;
  visitDateTime: string | null;
};

export type CrmIntegrityFilterInput = {
  agentName?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

export type CrmIntegrityData = {
  dateFrom: string;
  dateTo: string;
  filters: {
    agents: string[];
  };
  page: number;
  pageSize: number;
  rows: CrmIntegrityRow[];
  schemaReady: boolean;
  totalCount: number;
};
