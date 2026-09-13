/**
 * Native visits — the shapes the pages and the phone form share. Types only, so a "use client"
 * component can import them without pulling the server service into a browser bundle.
 */

import type {
  NativePartnerStatus,
  NativeVisitContactRule,
  NativeVisitGpsStatus,
  NativeVisitShift,
  NativeVisitTypeKey,
} from "@/lib/crm/native-visits/rules";

export type NativeVisitContactOption = {
  contactCrmId: number;
  name: string;
  speciality: string | null;
  grade: string | null;
  /** This rep's open lists holding the contact. One list decides the half-day; two leave it to him. */
  lists: NativeVisitShift[];
};

export type NativeVisitPartnerOption = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  isDirectManager: boolean;
};

export type NativeVisitFormOptions = {
  pilot: { lineName: string; startsOn: string; endsOn: string } | null;
  entryDays: { today: string; yesterday: string };
  /** Which of the two entry days fall inside the pilot. */
  openDays: string[];
  types: Array<{ key: NativeVisitTypeKey; label: string; contact: NativeVisitContactRule }>;
  contacts: NativeVisitContactOption[];
  partners: NativeVisitPartnerOption[];
};

export type NativeVisitPartnerView = {
  name: string;
  jobTitle: string | null;
  isDirectManager: boolean;
  status: NativePartnerStatus;
};

export type NativeVisitRow = {
  id: string;
  visitDate: string;
  shift: NativeVisitShift;
  visitType: NativeVisitTypeKey;
  typeLabel: string;
  contactName: string | null;
  prospectName: string | null;
  gpsStatus: NativeVisitGpsStatus;
  gpsAddress: string | null;
  comment: string | null;
  serverReceivedAt: string;
  deletedAt: string | null;
  deleteReason: string | null;
  canDelete: boolean;
  partners: NativeVisitPartnerView[];
};

export type NativeVisitConfirmationRow = {
  partnerId: number;
  status: NativePartnerStatus;
  repName: string;
  visitDate: string;
  shift: NativeVisitShift;
  typeLabel: string;
  contactName: string | null;
  prospectName: string | null;
  gpsStatus: NativeVisitGpsStatus;
  comment: string | null;
  isDirectManager: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
  canDecide: boolean;
};

export type NativeVisitEntryAvailability = {
  canLog: boolean;
  canConfirm: boolean;
  pendingConfirmations: number;
};

export type NativeVisitSaveResult = {
  visitId: string;
  duplicate: boolean;
  gpsStatus: NativeVisitGpsStatus;
};
