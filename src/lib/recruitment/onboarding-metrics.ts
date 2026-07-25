import type { CvDatabaseRow } from "@/lib/cv/cv-database";
import type { HiringDocumentDefinition, HiringDocumentEmployeeRow } from "@/lib/hiring-documents/types";

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

export type RecruitmentOnboardingMetrics = {
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
}): RecruitmentOnboardingMetrics {
  const documentMetrics = input.hiringDocumentEmployees && input.hiringDocumentDefinitions
    ? summarizeHiringDocumentReadiness(input.hiringDocumentEmployees, input.hiringDocumentDefinitions)
    : emptyHiringDocumentMetrics;
  return {
    candidatePipeline: input.candidateRows
      ? summarizeCandidatePipeline(input.candidateRows)
      : emptyCandidatePipelineMetrics,
    hiringDocuments: documentMetrics,
  };
}
