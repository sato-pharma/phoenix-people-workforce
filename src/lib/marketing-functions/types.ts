// Marketing Functions & Field Visit Feedback — the shapes the service, the routes and the screens share.

import type {
  CallRating,
  CallRemarkKey,
  FieldActionOwner,
  FieldVisitType,
  MarketingFunctionCategoryKey,
  MarketingFunctionOrigin,
  MarketingFunctionStatus,
  MarketingMonthStatus,
} from "./vocabulary";

export class MarketingFunctionsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MarketingFunctionsError";
    this.status = status;
  }
}

export function isMarketingFunctionsError(error: unknown): error is MarketingFunctionsError {
  return error instanceof MarketingFunctionsError;
}

export type MarketingFunctionItem = {
  id: string | null;
  categoryKey: MarketingFunctionCategoryKey;
  product: string | null;
  description: string;
  dueDate: string | null;
  origin: MarketingFunctionOrigin;
  statusMid: MarketingFunctionStatus | null;
  noteMid: string | null;
  statusEnd: MarketingFunctionStatus | null;
  noteEnd: string | null;
};

export type MarketingFunctionMonth = {
  id: string;
  authorHrId: string;
  monthKey: string;
  status: MarketingMonthStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedByHrId: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
};

/** A signed field-visit form, as a read-only line under Field Activity. */
export type FieldActivityLine = {
  id: string;
  visitDate: string;
  repName: string;
  visitType: FieldVisitType;
};

export type MarketingMonthSheet = {
  monthKey: string;
  authorHrId: string;
  authorName: string;
  month: MarketingFunctionMonth | null;
  items: MarketingFunctionItem[];
  fieldActivity: FieldActivityLine[];
  canEdit: boolean;
  canSubmit: boolean;
  canReview: boolean;
  canReopen: boolean;
  canCarryForward: boolean;
};

export type FieldFeedbackRatings = Partial<Record<CallRemarkKey, CallRating>>;

export type FieldFeedback = {
  id: string;
  authorHrId: string;
  authorName: string;
  visitType: FieldVisitType;
  repHrId: string;
  repName: string;
  repJobTitle: string | null;
  repArea: string | null;
  repLine: string | null;
  visitDate: string;
  amClinics: number | null;
  pmClinics: number | null;
  pharmacies: number | null;
  objectives: string | null;
  ratings: FieldFeedbackRatings;
  comments: string | null;
  doctorsComments: string | null;
  recommendations: string | null;
  actionOwners: FieldActionOwner[];
  fromCrmDay: boolean;
  signedAt: string | null;
  signedByName: string | null;
  updatedAt: string;
};

export type FieldFeedbackInput = {
  id?: string | null;
  visitType: FieldVisitType;
  repHrId: string;
  visitDate: string;
  amClinics: number | null;
  pmClinics: number | null;
  pharmacies: number | null;
  objectives: string | null;
  ratings: FieldFeedbackRatings;
  comments: string | null;
  doctorsComments: string | null;
  recommendations: string | null;
  actionOwners: FieldActionOwner[];
  fromCrmDay: boolean;
};

/** One logged Phoenix CRM day on which the Product Manager went along with a rep. */
export type RideAlongDay = {
  visitDate: string;
  repHrId: string;
  repName: string;
  repJobTitle: string | null;
  repArea: string | null;
  repLine: string | null;
  visitType: FieldVisitType;
  amClinics: number;
  pmClinics: number;
  pharmacies: number;
  alreadyFiled: boolean;
};

export type RepOption = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  area: string | null;
  line: string | null;
};
