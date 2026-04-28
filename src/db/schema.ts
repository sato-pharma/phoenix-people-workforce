import {
  type AnyPgColumn,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps(),
});

export const lines = pgTable("lines", {
  id: serial("id").primaryKey(),
  departmentId: integer("department_id")
    .notNull()
    .references(() => departments.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps(),
});

export const areas = pgTable("areas", {
  id: serial("id").primaryKey(),
  lineId: integer("line_id")
    .notNull()
    .references(() => lines.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps(),
});

export const teams = pgTable("teams", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id")
    .notNull()
    .references(() => areas.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps(),
});

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  departmentId: integer("department_id").references(() => departments.id, {
    onDelete: "set null",
  }),
  lineId: integer("line_id").references(() => lines.id, {
    onDelete: "set null",
  }),
  areaId: integer("area_id").references(() => areas.id, {
    onDelete: "set null",
  }),
  teamId: integer("team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  code: varchar("code", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 160 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps(),
});

export const employees = pgTable("employees", {
  hrId: varchar("hr_id", { length: 64 }).primaryKey(),
  fullName: varchar("full_name", { length: 220 }).notNull(),
  nameAr: varchar("name_ar", { length: 220 }),
  crmId: varchar("crm_id", { length: 80 }),
  crmUsername: varchar("crm_username", { length: 160 }),
  workEmail: varchar("work_email", { length: 255 }).unique(),
  mobileNumber: varchar("mobile_number", { length: 40 }),
  jobTitle: varchar("job_title", { length: 160 }),
  hireDate: date("hire_date"),
  employmentStatus: varchar("employment_status", { length: 40 }),
  education: varchar("education", { length: 160 }),
  managerHrId: varchar("manager_hr_id", { length: 64 }).references(
    (): AnyPgColumn => employees.hrId,
    { onDelete: "set null" },
  ),
  departmentId: integer("department_id").references(() => departments.id, {
    onDelete: "set null",
  }),
  lineId: integer("line_id").references(() => lines.id, {
    onDelete: "set null",
  }),
  areaId: integer("area_id").references(() => areas.id, {
    onDelete: "set null",
  }),
  teamId: integer("team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  positionId: integer("position_id").references(() => positions.id, {
    onDelete: "set null",
  }),
  ...timestamps(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 180 }),
  employeeHrId: varchar("employee_hr_id", { length: 64 }).references(
    () => employees.hrId,
    { onDelete: "set null" },
  ),
  isActive: boolean("is_active").default(true).notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  ...timestamps(),
});

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 80 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  isSystem: boolean("is_system").default(false).notNull(),
  ...timestamps(),
});

export const permissions = pgTable("permissions", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  ...timestamps(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

export const employeeHistory = pgTable("employee_history", {
  id: serial("id").primaryKey(),
  employeeHrId: varchar("employee_hr_id", { length: 64 })
    .notNull()
    .references(() => employees.hrId, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  departmentId: integer("department_id").references(() => departments.id, {
    onDelete: "set null",
  }),
  lineId: integer("line_id").references(() => lines.id, {
    onDelete: "set null",
  }),
  areaId: integer("area_id").references(() => areas.id, {
    onDelete: "set null",
  }),
  teamId: integer("team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  positionId: integer("position_id").references(() => positions.id, {
    onDelete: "set null",
  }),
  note: text("note"),
  changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const employeeDocuments = pgTable("employee_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  employeeHrId: varchar("employee_hr_id", { length: 64 })
    .notNull()
    .references(() => employees.hrId, { onDelete: "cascade" }),
  documentType: varchar("document_type", { length: 80 }).notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  fileKey: varchar("file_key", { length: 500 }).notNull(),
  fileName: varchar("file_name", { length: 255 }),
  mimeType: varchar("mime_type", { length: 120 }),
  sizeBytes: integer("size_bytes"),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const systemAuditLogs = pgTable("system_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  action: varchar("action", { length: 120 }).notNull(),
  entityType: varchar("entity_type", { length: 120 }).notNull(),
  entityId: varchar("entity_id", { length: 180 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ipAddress: varchar("ip_address", { length: 80 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const platformSettings = pgTable("platform_settings", {
  key: varchar("key", { length: 120 }).primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  description: text("description"),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
