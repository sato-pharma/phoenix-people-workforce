/**
 * @deprecated Re-export shim. The CRM config moved to `@/lib/crm/config` as part of
 * centralizing all iReports360 access behind the CRM module. Import from `@/lib/crm/config`
 * directly; this shim exists only to keep existing importers working during the migration
 * and will be removed once every consumer is repointed.
 */
export * from "@/lib/crm/config";
