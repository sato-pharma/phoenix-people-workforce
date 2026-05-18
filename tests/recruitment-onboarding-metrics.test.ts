import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRecruitmentOnboardingMetrics,
  summarizeCandidatePipeline,
  summarizeHiringDocumentReadiness,
  summarizeOfferLifecycleRows,
} from "../src/lib/recruitment/onboarding-metrics.ts";

export function runRecruitmentOnboardingMetricsTests() {
  const offerRows = [
    {
      acceptedAt: "2026-01-02T12:00:00.000Z",
      areaId: 1,
      areaScope: "Nasr City",
      candidateEmail: "accepted@example.com",
      candidateName: "Accepted Candidate",
      candidatePhone: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      departmentId: 1,
      departmentName: "Sales",
      employeeHrId: "MR-100",
      expiresAt: "2026-02-01T00:00:00.000Z",
      id: "offer-1",
      jobTitle: "Medical Rep",
      lineId: 7,
      lineName: "CNS",
      managerHrId: "DSM-1",
      managerName: "Manager",
      offerCode: "OFF-1",
      onboardingStatus: "approved",
      positionId: 5,
      rejectedAt: null,
      salaryAmount: 10000,
      startDate: "2026-02-01",
      status: "accepted" as const,
      templateKey: null,
      updatedAt: "2026-01-02T12:00:00.000Z",
    },
    {
      acceptedAt: "2026-01-03T12:00:00.000Z",
      areaId: 2,
      areaScope: "Heliopolis",
      candidateEmail: "pending-approval@example.com",
      candidateName: "Pending Approval",
      candidatePhone: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      departmentId: 1,
      departmentName: "Sales",
      employeeHrId: null,
      expiresAt: "2026-02-01T00:00:00.000Z",
      id: "offer-2",
      jobTitle: "Medical Rep",
      lineId: 7,
      lineName: "CNS",
      managerHrId: "DSM-1",
      managerName: "Manager",
      offerCode: "OFF-2",
      onboardingStatus: "pending_hr_approval",
      positionId: 5,
      rejectedAt: null,
      salaryAmount: 10000,
      startDate: "2026-02-01",
      status: "accepted" as const,
      templateKey: null,
      updatedAt: "2026-01-03T12:00:00.000Z",
    },
    {
      acceptedAt: null,
      areaId: null,
      areaScope: null,
      candidateEmail: "rejected@example.com",
      candidateName: "Rejected Candidate",
      candidatePhone: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      departmentId: null,
      departmentName: null,
      employeeHrId: null,
      expiresAt: "2026-02-01T00:00:00.000Z",
      id: "offer-3",
      jobTitle: "Medical Rep",
      lineId: null,
      lineName: null,
      managerHrId: null,
      managerName: null,
      offerCode: "OFF-3",
      onboardingStatus: "not_started",
      positionId: null,
      rejectedAt: "2026-01-03T12:00:00.000Z",
      salaryAmount: 10000,
      startDate: null,
      status: "rejected" as const,
      templateKey: null,
      updatedAt: "2026-01-03T12:00:00.000Z",
    },
    {
      acceptedAt: null,
      areaId: 1,
      areaScope: "Nasr City",
      candidateEmail: "pending@example.com",
      candidateName: "Pending Candidate",
      candidatePhone: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      departmentId: 1,
      departmentName: "Sales",
      employeeHrId: null,
      expiresAt: "2026-02-01T00:00:00.000Z",
      id: "offer-4",
      jobTitle: "Medical Rep",
      lineId: 7,
      lineName: "CNS",
      managerHrId: "DSM-1",
      managerName: "Manager",
      offerCode: "OFF-4",
      onboardingStatus: "not_started",
      positionId: 5,
      rejectedAt: null,
      salaryAmount: 10000,
      startDate: null,
      status: "sent" as const,
      templateKey: null,
      updatedAt: "2026-01-01T12:00:00.000Z",
    },
  ];

  const offerMetrics = summarizeOfferLifecycleRows(offerRows);
  assert.equal(offerMetrics.totalOffers, 4);
  assert.equal(offerMetrics.acceptedOffers, 2);
  assert.equal(offerMetrics.rejectedOffers, 1);
  assert.equal(offerMetrics.pendingOffers, 1);
  assert.equal(offerMetrics.acceptanceRate, 2 / 3);
  assert.equal(offerMetrics.acceptedToEmployeeConversions, 1);
  assert.equal(offerMetrics.acceptedToEmployeeConversionRate, 0.5);
  assert.equal(offerMetrics.pendingHrApprovalOffers, 1);
  assert.equal(offerMetrics.vacancyLinkedOffers, 3);

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
    offerRows,
  });
  assert.equal(combined.acceptedOffers, 2);
  assert.equal(combined.hiringDocuments.readinessRate, 1);

  const offerSource = readFileSync("src/lib/offers/service.ts", "utf8");
  assert.match(offerSource, /summarizeOfferLifecycleRows/);
  assert.match(offerSource, /phx_approve_accepted_offer/);
  assert.match(offerSource, /closeVacancyForOffer/);

  const hiringDocumentsSource = readFileSync("src/lib/hiring-documents/service.ts", "utf8");
  assert.match(hiringDocumentsSource, /summarizeHiringDocumentReadiness/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /buildRecruitmentOnboardingMetrics/);
  assert.match(platformSource, /getHiringDocumentsDashboard/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /buildRecruitmentOnboardingMetrics/);
  assert.doesNotMatch(commandCenterSource, /acceptedOffers = offers\.filter/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /platformMetrics\.recruitment\.acceptedOffers/);
  assert.doesNotMatch(overviewSource, /getOfferDashboard/);
}

