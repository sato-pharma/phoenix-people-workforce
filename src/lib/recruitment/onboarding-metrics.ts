import type { CvDatabaseRow } from "@/lib/cv/cv-database";
import type { HiringDocumentDefinition, HiringDocumentEmployeeRow } from "@/lib/hiring-documents/types";
import type { OfferLifecycleRow } from "@/lib/offers/service";

export type RecruitmentOfferMetrics = {
  acceptanceRate: number;
  acceptedOffers: number;
  acceptedToEmployeeConversions: number;
  acceptedToEmployeeConversionRate: number;
  averageHoursToAccept: number;
  expiredOffers: number;
  pendingHrApprovalOffers: number;
  pendingOffers: number;
  rejectedOffers: number;
  totalOffers: number;
  vacancyLinkedOffers: number;
  vacancyLinkageRate: number;
};

export type OnboardingDocumentMetrics = {
  completeDocuments: number;
  dueDocuments: number;
  employees: number;
  missingDocuments: number;
  pendingDocuments: number;
  readinessRate: number;
  submittedDocuments: number;
  totalDocumentSlots: number;
};

export type CandidatePipelineMetrics = {
  candidates: number;
  experienced: number;
  fresh: number;
  unknown: number;
};

export type RecruitmentOnboardingMetrics = RecruitmentOfferMetrics & {
  candidatePipeline: CandidatePipelineMetrics;
  hiringDocuments: OnboardingDocumentMetrics;
};

const emptyHiringDocumentMetrics: OnboardingDocumentMetrics = {
  completeDocuments: 0,
  dueDocuments: 0,
  employees: 0,
  missingDocuments: 0,
  pendingDocuments: 0,
  readinessRate: 1,
  submittedDocuments: 0,
  totalDocumentSlots: 0,
};

const emptyCandidatePipelineMetrics: CandidatePipelineMetrics = {
  candidates: 0,
  experienced: 0,
  fresh: 0,
  unknown: 0,
};

function isPastDueMissingDocument(entry: { dueDate: string | null; status: string }, today: Date) {
  if (entry.status !== "missing" || !entry.dueDate) return false;
  const dueDate = new Date(`${entry.dueDate}T00:00:00`);
  return !Number.isNaN(dueDate.getTime()) && dueDate <= today;
}

export function summarizeOfferLifecycleRows(rows: OfferLifecycleRow[]): RecruitmentOfferMetrics {
  const accepted = rows.filter((row) => row.status === "accepted" || row.status === "hired");
  const rejected = rows.filter((row) => ["cancelled", "rejected", "withdrawn"].includes(row.status));
  const final = [...accepted, ...rejected];
  const converted = accepted.filter((row) => Boolean(row.employeeHrId));
  const vacancyLinked = rows.filter((row) =>
    Boolean(row.areaId && row.lineId && row.positionId && row.managerHrId),
  );
  const averageHoursToAccept =
    accepted.length === 0
      ? 0
      : accepted.reduce((sum, row) => {
          if (!row.acceptedAt) return sum;
          return sum + (new Date(row.acceptedAt).getTime() - new Date(row.createdAt).getTime()) / 36e5;
        }, 0) / accepted.length;

  return {
    acceptanceRate: final.length ? accepted.length / final.length : 0,
    acceptedOffers: accepted.length,
    acceptedToEmployeeConversions: converted.length,
    acceptedToEmployeeConversionRate: accepted.length ? converted.length / accepted.length : 0,
    averageHoursToAccept,
    expiredOffers: rows.filter((row) => row.status === "expired").length,
    pendingHrApprovalOffers: accepted.filter((row) => row.onboardingStatus === "pending_hr_approval").length,
    pendingOffers: rows.filter((row) => row.status === "sent").length,
    rejectedOffers: rejected.length,
    totalOffers: rows.length,
    vacancyLinkedOffers: vacancyLinked.length,
    vacancyLinkageRate: rows.length ? vacancyLinked.length / rows.length : 1,
  };
}

export function summarizeHiringDocumentReadiness(
  employees: HiringDocumentEmployeeRow[],
  documents: HiringDocumentDefinition[],
): OnboardingDocumentMetrics {
  let submittedDocuments = 0;
  let missingDocuments = 0;
  let pendingDocuments = 0;
  let dueDocuments = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const employee of employees) {
    for (const document of documents) {
      const entry = employee.documents[document.id] ?? {
        documentId: document.id,
        dueDate: null,
        notes: null,
        status: "pending",
        updatedAt: null,
      };
      if (entry.status === "submitted") submittedDocuments += 1;
      if (entry.status === "missing") missingDocuments += 1;
      if (entry.status === "pending") pendingDocuments += 1;
      if (isPastDueMissingDocument(entry, today)) dueDocuments += 1;
    }
  }

  const totalDocumentSlots = employees.length * documents.length;
  return {
    completeDocuments: submittedDocuments,
    dueDocuments,
    employees: employees.length,
    missingDocuments,
    pendingDocuments,
    readinessRate: totalDocumentSlots > 0 ? submittedDocuments / totalDocumentSlots : 1,
    submittedDocuments,
    totalDocumentSlots,
  };
}

export function summarizeCandidatePipeline(rows: CvDatabaseRow[]): CandidatePipelineMetrics {
  return {
    candidates: rows.length,
    experienced: rows.filter((row) => row.status === "experienced").length,
    fresh: rows.filter((row) => row.status === "fresh").length,
    unknown: rows.filter((row) => row.status === "unknown").length,
  };
}

export function buildRecruitmentOnboardingMetrics(input: {
  candidateRows?: CvDatabaseRow[];
  hiringDocumentEmployees?: HiringDocumentEmployeeRow[];
  hiringDocumentDefinitions?: HiringDocumentDefinition[];
  offerRows: OfferLifecycleRow[];
}): RecruitmentOnboardingMetrics {
  const offerMetrics = summarizeOfferLifecycleRows(input.offerRows);
  const documentMetrics = input.hiringDocumentEmployees && input.hiringDocumentDefinitions
    ? summarizeHiringDocumentReadiness(input.hiringDocumentEmployees, input.hiringDocumentDefinitions)
    : emptyHiringDocumentMetrics;
  return {
    ...offerMetrics,
    candidatePipeline: input.candidateRows
      ? summarizeCandidatePipeline(input.candidateRows)
      : emptyCandidatePipelineMetrics,
    hiringDocuments: documentMetrics,
  };
}
