import type {
  ContactListAction,
  ContactListChangeStatus,
  ContactListShift,
} from "@/lib/crm/contact-lists/rules";

/** One doctor on one of the shown rep's lists today. */
export type ContactListEntry = {
  contactCrmId: number;
  name: string;
  speciality: string | null;
  address: string | null;
  listType: ContactListShift;
  grade: string | null;
  /** The day this period on the list began. */
  since: string;
  /** A change for this doctor on this list is waiting for the manager. */
  pendingChange: boolean;
};

export type ContactListChangeRow = {
  id: string;
  repName: string;
  action: ContactListAction;
  listType: ContactListShift;
  doctorName: string;
  doctorSpeciality: string | null;
  /** The new grade for an add or a grade change. */
  grade: string | null;
  reason: string;
  status: ContactListChangeStatus;
  direct: boolean;
  requestedByName: string;
  managerName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** This viewer is the manager it was sent to and may still approve or refuse it. */
  canDecide: boolean;
  /** The rep may withdraw his own waiting request. */
  canCancel: boolean;
};

/** A rep the SFE Manager or the administrator can open. The id is the picker's value, never shown. */
export type ContactListRepOption = { hrId: string; name: string; detail: string };

export type ContactListView = {
  /** On or after the CRM cutover date. Before it, lists are shown but cannot be changed. */
  inForce: boolean;
  cutoverDate: string | null;
  canRequest: boolean;
  canDecide: boolean;
  canEditDirectly: boolean;
  /** The rep whose list is shown: the rep himself, or the one the editor picked. */
  rep: { hrId: string; name: string; managerName: string | null } | null;
  entries: ContactListEntry[];
  /** Recent changes to the shown rep's list. */
  changes: ContactListChangeRow[];
  /** Requests sent to this viewer as manager. */
  toDecide: ContactListChangeRow[];
  /** For the editor: every request still waiting for a manager. */
  waitingCompany: ContactListChangeRow[];
  repOptions: ContactListRepOption[];
  specialityOptions: string[];
};

export type ContactListSearchResult = {
  contactCrmId: number;
  name: string;
  speciality: string | null;
  address: string | null;
};

export type ContactListAvailability = {
  /** Link the page. False until the CRM cutover date is set. */
  show: boolean;
  canRequest: boolean;
  /** Requests waiting for this viewer's answer as manager. */
  waitingForYou: number;
};
