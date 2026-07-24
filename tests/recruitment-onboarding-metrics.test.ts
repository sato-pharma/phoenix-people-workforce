import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRecruitmentOnboardingMetrics,
  summarizeCandidatePipeline,
  summarizeHiringDocumentReadiness,
} from "../src/lib/recruitment/onboarding-metrics.ts";

export function runRecruitmentOnboardingMetricsTests() {
  const documents = [
    { createdAt: "2026-01-01", description: null, displayOrder: 10, id: "id", name: "National ID" },
    { createdAt: "2026-01-01", description: null, displayOrder: 20, id: "contract", name: "Contract" },
  ];
  const documentMetrics = summarizeHiringDocumentReadiness(
    [
      {
        documents: {
          id: { documentId: "id", dueDate: null, notes: null, status: "submitted", updatedAt: null },
          contract: { documentId: "contract", dueDate: "2000-01-01", notes: null, status: "missing", updatedAt: null },
        },
        employmentStatus: "active",
        fullName: "Employee One",
        hireDate: "2026-01-01",
        hrId: "MR-100",
        jobTitle: "Medical Rep",
        lineName: "CNS",
        managerHrId: "DSM-1",
        managerName: "Manager",
        notes: null,
      },
    ],
    documents,
  );
  assert.equal(documentMetrics.totalDocumentSlots, 2);
  assert.equal(documentMetrics.submittedDocuments, 1);
  assert.equal(documentMetrics.missingDocuments, 1);
  assert.equal(documentMetrics.dueDocuments, 1);
  assert.equal(documentMetrics.readinessRate, 0.5);

  const candidates = summarizeCandidatePipeline([
    { companies: "", companyList: [], cvName: "a.pdf", dateOfSendingCv: "", duration: "", durationMonths: null, from: "", medicalSalesExp: "Yes", name: "A", rowNumber: 1, status: "experienced", to: "" },
    { companies: "", companyList: [], cvName: "b.pdf", dateOfSendingCv: "", duration: "", durationMonths: null, from: "", medicalSalesExp: "No", name: "B", rowNumber: 2, status: "fresh", to: "" },
  ]);
  assert.equal(candidates.candidates, 2);
  assert.equal(candidates.experienced, 1);
  assert.equal(candidates.fresh, 1);

  const combined = buildRecruitmentOnboardingMetrics({
    candidateRows: [],
    hiringDocumentDefinitions: documents,
    hiringDocumentEmployees: [],
  });
  assert.equal(combined.hiringDocuments.readinessRate, 1);

  const hiringDocumentsSource = readFileSync("src/lib/hiring-documents/service.ts", "utf8");
  assert.match(hiringDocumentsSource, /summarizeHiringDocumentReadiness/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /buildRecruitmentOnboardingMetrics/);
  assert.match(platformSource, /getHiringDocumentsDashboard/);
}
