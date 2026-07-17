/**
 * @deprecated Re-export shim. The CRM HTTP client moved to `@/lib/crm/client` as part of
 * centralizing all iReports360 access behind the CRM module. Import from `@/lib/crm/client`
 * directly; this shim exists only to keep existing importers working during the migration
 * and will be removed once every consumer is repointed.
 */
export * from "@/lib/crm/client";
