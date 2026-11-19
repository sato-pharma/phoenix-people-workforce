import type { ZodType } from "zod";

/**
 * EVERY MONEY ROUTE JUDGES ITS BODY WITH A SCHEMA (REC-060, money slice, 19 Nov 2026).
 *
 * The payroll, automated payroll, deduction, dispute, outstation and expense routes, and the direct-order
 * collection, used to cast whatever arrived — `(await request.json()) as { … }` — and let the service find
 * out later that an amount was a string or an array was an object. Each now reads its body ONLY through one
 * of the two readers below, with a zod schema that accepts everything its screen sends today, and answers a
 * body the schema refuses with its OWN error shape and status (the reader never builds a response).
 * `tests/money-route-body-schema.test.ts` lists every money route that still reads a body any other way and
 * refuses a new one.
 *
 * Order (REC-080, #585): a route asks who the caller is and refuses a stranger BEFORE it reads the body, so
 * a signed-out caller never learns which bodies are good. The reader is called after that check, never
 * before it.
 */

export type BodyParseResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** One plain sentence naming the first field the schema refused, for the route's own 400. */
      message: string;
      /** "invalid_json": the body was not JSON and the route gave no fallback; "schema": the shape was wrong. */
      reason: "invalid_json" | "schema";
    };

type SchemaIssue = { path?: ReadonlyArray<PropertyKey>; message?: string };

/** "items.0.amount: Invalid input: expected number, received string" — the first issue, in one line. */
export function describeSchemaIssue(issues: ReadonlyArray<SchemaIssue> | undefined): string {
  const first = issues?.[0];
  if (!first) return "Invalid request body.";
  const path = (first.path ?? []).map((part) => String(part)).join(".");
  const message = String(first.message ?? "is not valid");
  return path ? `Invalid request body: ${path}: ${message}` : `Invalid request body: ${message}`;
}

function judge<T>(schema: ZodType<T>, value: unknown): BodyParseResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, reason: "schema", message: describeSchemaIssue(parsed.error.issues) };
}

const NO_FALLBACK: unique symbol = Symbol("no-fallback");

/**
 * Read a JSON body and judge it with `schema`.
 *
 * `fallback` is what an empty or unreadable body becomes BEFORE it is judged — the value the route used to
 * put in its `.catch(() => …)`, so a route that tolerated "no body" still does (`{}` for a cancel with no
 * override, `null` where the route asked for nothing). Leave it out and an unreadable body is refused as
 * `invalid_json`, for the routes that already answered that with a 400.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  options: { fallback?: unknown } = {},
): Promise<BodyParseResult<T>> {
  const fallback = Object.prototype.hasOwnProperty.call(options, "fallback") ? options.fallback : NO_FALLBACK;
  let value: unknown;
  try {
    const text = await request.text();
    if (text.trim() === "") {
      if (fallback === NO_FALLBACK) return { ok: false, reason: "invalid_json", message: "Invalid request body: expected JSON." };
      value = fallback;
    } else {
      value = JSON.parse(text) as unknown;
    }
  } catch {
    if (fallback === NO_FALLBACK) return { ok: false, reason: "invalid_json", message: "Invalid request body: expected JSON." };
    value = fallback;
  }
  return judge(schema, value);
}

/**
 * Read a multipart form and judge its fields with `schema`. Each key becomes its one value (a string or a
 * File), or an array when the form repeats it — so a schema names `file: z.instanceof(File)` or
 * `files: z.array(z.instanceof(File))` directly. The raw FormData is handed back as well, for a route that
 * still walks it.
 */
export async function parseFormBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<BodyParseResult<T> & { form?: FormData }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, reason: "invalid_json", message: "Invalid request body: expected a form upload." };
  }
  const fields: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    fields[key] = values.length === 1 ? values[0] : values;
  }
  const result = judge(schema, fields);
  return result.ok ? { ...result, form } : result;
}
