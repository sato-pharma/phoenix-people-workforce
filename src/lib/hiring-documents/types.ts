export type HiringDocumentStatus = "pending" | "submitted" | "missing";

export type HiringDocumentDefinition = {
  createdAt: string;
  description: string | null;
  displayOrder: number;
  id: string;
  name: string;
};

export type HiringDocumentEntry = {
  documentId: string;
  dueDate: string | null;
  notes: string | null;
  status: HiringDocumentStatus;
  updatedAt: string | null;
};

export type HiringDocumentEmployeeRow = {
  employmentStatus: string | null;
  fullName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  notes: string | null;
  documents: Record<string, HiringDocumentEntry>;
};

export type HiringDocumentsDashboardData = {
  documents: HiringDocumentDefinition[];
  employees: HiringDocumentEmployeeRow[];
  summary: {
    completeDocuments: number;
    dueDocuments: number;
    employees: number;
    missingDocuments: number;
    pendingDocuments: number;
    submittedDocuments: number;
    totalDocumentSlots: number;
  };
};

export type UpdateHiringDocumentStatusInput = {
  documentId: string;
  dueDate?: string | null;
  employeeHrId: string;
  notes?: string | null;
  status: HiringDocumentStatus;
};

export type UpdateHiringDocumentNotesInput = {
  employeeHrId: string;
  notes: string | null;
};

export type CreateHiringDocumentDefinitionInput = {
  description?: string | null;
  name: string;
};
