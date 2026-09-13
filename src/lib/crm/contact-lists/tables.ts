/**
 * Table and function names for doctor lists maintained in Phoenix (CRM phase 7).
 *
 * The lists themselves stay in crm_contact_assignments (src/lib/crm/tables.ts); these name the change
 * requests, their history, and the one database function allowed to apply a change to a list.
 */

export const CRM_CONTACT_LIST_CHANGES_TABLE = "crm_contact_list_changes";
export const CRM_CONTACT_LIST_CHANGE_EVENTS_TABLE = "crm_contact_list_change_events";
export const CRM_CONTACT_LIST_CHANGE_APPLY_FUNCTION = "crm_contact_list_change_apply";
