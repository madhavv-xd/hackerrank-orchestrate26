// Dataset loading: RFC 4180 CSV + zod validation at the trust boundary.
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATASET = join(REPO_ROOT, "dataset");

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

export const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/);

export const RequestSchema = z.object({
  case_id: z.string().regex(/^case_\d+$/),
  email: z.string().min(3),
  requested_at: iso,
  reported_status: z.enum(["COMPLETE", "PARTIALLY_COMPLETE", "NOT_STARTED"]),
  reported_at: iso,
  audit_at: iso,
  request_text: z.string(),
});
export const IdentitySchema = z.object({
  user_id: z.string(), name: z.string(), email: z.string(), phone: z.string(), email_hash: z.string(), updated_at: iso,
});
export const AuditSchema = z.object({
  audit_id: z.string(), user_id: z.string(), event_time: iso, field_name: z.string(), old_value: z.string(), new_value: z.string(),
});
export const ActivitySchema = z.object({
  activity_id: z.string(), event_time: iso, event_type: z.string(), source_system: z.string(),
  target_system: z.string(), resource_id: z.string(), reported_result: z.string(), details: z.string(),
});
export const RuleSchema = z.object({
  rule_id: z.string(), data_category: z.string(), condition: z.string(),
  required_action: z.enum(["DELETE", "REDACT", "ANONYMIZE", "RETAIN"]),
});
export const ManifestSchema = z.object({ file_id: z.string(), file_path: z.string(), origin: z.string(), captured_at: iso });

export const PHASES = ["FINDING", "REMEDIATION", "VERIFICATION"] as const;
export const OPERATIONS = {
  REPORT_REMAINING_RECORD: ["FINDING", "PRESENT"],
  REPORT_EXPOSED_PII: ["FINDING", "PRESENT"],
  REPORT_ACTIVE_DATA_FLOW: ["FINDING", "ACTIVE"],
  REPORT_RESTORE_RISK: ["FINDING", "ACTIVE"],
  DISABLE_DATA_FLOW: ["REMEDIATION", "DISABLED"],
  BLOCK_RESTORE: ["REMEDIATION", "BLOCKED"],
  DELETE_RECORD: ["REMEDIATION", "ABSENT"],
  REDACT_RECORD: ["REMEDIATION", "REDACTED"],
  ANONYMIZE_RECORD: ["REMEDIATION", "ANONYMIZED"],
  VERIFY_RECORD_ABSENT: ["VERIFICATION", "ABSENT"],
  VERIFY_RECORD_PRESENT: ["VERIFICATION", "PRESENT"],
  VERIFY_RECORD_REDACTED: ["VERIFICATION", "REDACTED"],
  VERIFY_RECORD_ANONYMIZED: ["VERIFICATION", "ANONYMIZED"],
  VERIFY_DATA_FLOW_DISABLED: ["VERIFICATION", "DISABLED"],
  VERIFY_RESTORE_BLOCKED: ["VERIFICATION", "BLOCKED"],
} as const;
export type Operation = keyof typeof OPERATIONS;

export const StepSchema = z.object({
  step_no: z.number().int().positive(),
  phase: z.enum(PHASES),
  system_id: z.string().min(1),
  resource_id: z.string().min(1),
  operation: z.enum(Object.keys(OPERATIONS) as [Operation, ...Operation[]]),
  state: z.string(),
  evidence_id: z.string(),
});
export type Step = z.infer<typeof StepSchema>;
export const OutputRowSchema = z.object({
  case_id: z.string(),
  deletion_status: z.enum(["COMPLETE", "INCOMPLETE", "NOT_APPLICABLE"]),
  steps_json: z.string(),
});

export type Request = z.infer<typeof RequestSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
export type AuditRow = z.infer<typeof AuditSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type ManifestRow = z.infer<typeof ManifestSchema>;

export function loadCsv<T>(file: string, schema: z.ZodType<T>, dir = DATASET): T[] {
  return parseCsv(readFileSync(join(dir, file), "utf8")).map((r, i) => {
    const parsed = schema.safeParse(r);
    if (!parsed.success) throw new Error(`${file} row ${i + 2}: ${parsed.error.message}`);
    return parsed.data;
  });
}

export function loadDataset(dir = DATASET) {
  return {
    requests: loadCsv("deletion_requests.csv", RequestSchema, dir),
    samples: loadCsv("sample_deletion_requests.csv", RequestSchema, dir),
    sampleOutput: loadCsv("sample_output.csv", OutputRowSchema, dir),
    identities: loadCsv("user_identities.csv", IdentitySchema, dir),
    auditLog: loadCsv("user_audit_log.csv", AuditSchema, dir),
    activity: loadCsv("system_activity.csv", ActivitySchema, dir),
    rules: loadCsv("deletion_rules.csv", RuleSchema, dir),
    manifest: loadCsv("evidence_files.csv", ManifestSchema, dir),
    dir,
  };
}
export type Dataset = ReturnType<typeof loadDataset>;
