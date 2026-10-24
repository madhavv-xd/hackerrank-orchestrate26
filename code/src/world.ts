// Stage 5 — world model: interpret raw records as facts and reconstruct each resource's state at audit_at.
import type { Coverage, EvidenceIndex, Fields, RawRecord } from "./evidence.ts";
import { prefixOf, systemOf } from "./evidence.ts";
import type { IdentityResolver } from "./identity.ts";

export interface Observation {
  fileId: string; fileAt: string; at: string; resourceId: string; system: string;
  owners: Set<string>; // users this record is linked to (any identifier: data fields or lookup keys)
  present: boolean;
  pii: boolean | null; // direct identifiers still in the record (null = not determinable)
  active: boolean | null; // data flow enabled / restore allowed
  recordType: string | null;
  attachment: boolean;
  raw: RawRecord;
}

// Fields whose value is the record's own data (direct identifiers that policy may require removed).
const PII_FIELDS = ["email", "phone", "full_name", "name", "display_name", "requester_email", "requester_name", "requester_phone",
  "owner_email", "owner_phone", "customer_email", "email_hash", "matched_value", "uploaded_by"];
// Free text that may quote a direct identifier.
const TEXT_FIELDS = ["message_text", "message_excerpt"];
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// Fields that only say who the record is about (queries, stable references, document mentions).
const LINK_FIELDS = ["customer_reference", "subject_reference", "user_id", "lookup_key", "match_key", "subject_key", "scan_key",
  "subject_ref", "correlation_key", "query", "subject_selector", "document_emails", "document_users"];

const val = (f: Fields, k: string) => { const v = f[k]; return v === null || v === undefined || v === "" || v === "null" || v === "—" ? null : v; };
const truthy = (v: string | null) => v !== null && /^(true|1|yes)$/i.test(v);
const falsy = (v: string | null) => v !== null && /^(false|0|no)$/i.test(v);

export function interpret(r: RawRecord, ids: IdentityResolver): Observation {
  const f = r.fields;
  const owners = new Set<string>();
  for (const k of [...PII_FIELDS, ...LINK_FIELDS]) for (const part of (val(f, k) ?? "").split(",")) { const u = ids.resolve(part); if (u) owners.add(u); }
  for (const k of TEXT_FIELDS) for (const e of (val(f, k) ?? "").match(new RegExp(EMAIL_RE, "g")) ?? []) { const u = ids.resolve(e.replace(/\.$/, "")); if (u) owners.add(u); }
  const result = val(f, "result")?.toUpperCase() ?? null;
  const status = val(f, "status")?.toLowerCase() ?? "";
  const absent = val(f, "status_code") === "404" || val(f, "http_status") === "404" || val(f, "rows") === "0" ||
    result === "NOT_FOUND" || result === "MISS" || val(f, "total") === "0";
  let pii: boolean | null = PII_FIELDS.some((k) => val(f, k) !== null) || Number(val(f, "direct_identifiers") ?? 0) > 0 ||
    TEXT_FIELDS.some((k) => EMAIL_RE.test(val(f, k) ?? ""));
  if (result === "ANONYMIZED" || result === "REDACTED") pii = false;
  else if (result === "IDENTIFIABLE") pii = true;
  else if (result === "FOUND" || result === "ACTIVE") pii = /@/.test(val(f, "subject_reference") ?? "") || pii;
  if (r.source === "pdf") pii = !!val(f, "document_emails");
  if (val(f, "direct_identifiers") === "0") pii = false;
  let active: boolean | null = null;
  const enabled = val(f, "enabled") ?? val(f, "restore_allowed") ?? val(f, "scheduler_registered");
  if (truthy(enabled) || result === "ACTIVE" || /healthy|continuous/.test(status)) active = true;
  if (falsy(enabled) || result === "DISABLED" || result === "BLOCKED" || val(f, "last_delivery_status") === "stopped") active = false;
  const recordType = val(f, "record_type");
  const attachment = recordType === "SUPPORT_ATTACHMENT" || /attachment/.test(val(f, "event") ?? "") || /attachment/.test(val(f, "collection_name") ?? "") ||
    /attachment|\.pdf/i.test(val(f, "file") ?? "") || prefixOf(r.resourceId) === "object" || (r.source === "pdf" && prefixOf(r.resourceId) === "support");
  return { fileId: r.fileId, fileAt: r.fileAt, at: r.at, resourceId: r.resourceId, system: val(f, "system") ?? systemOf(r.resourceId),
    owners, present: !absent, pii, active, recordType, attachment, raw: r };
}

export interface World { obs: Map<string, Observation[]>; coverage: Coverage[] }
export function buildWorld(index: EvidenceIndex, ids: IdentityResolver): World {
  const obs = new Map<string, Observation[]>();
  for (const r of index.records) { const o = interpret(r, ids); obs.set(o.resourceId, [...(obs.get(o.resourceId) ?? []), o]); }
  for (const list of obs.values()) list.sort((a, b) => a.at.localeCompare(b.at) || a.fileAt.localeCompare(b.fileAt) || a.fileId.localeCompare(b.fileId));
  return { obs, coverage: index.coverage };
}

/** Evidence usable for a case: the file existed at audit time and the record was observed by then. */
export const usable = (o: { fileAt: string; at: string }, auditAt: string) => o.fileAt <= auditAt && o.at <= auditAt;

export interface State { present: boolean; pii: boolean | null; active: boolean | null; evidence: string; at: string; explicit: boolean; obs: Observation | null }
export function stateAt(world: World, rid: string, auditAt: string): State | null {
  const list = (world.obs.get(rid) ?? []).filter((o) => usable(o, auditAt));
  // A replica/region copy anywhere in the latest snapshot keeps the record alive: merge observations sharing the latest time+file.
  const last = list[list.length - 1];
  if (last) {
    const same = list.filter((o) => o.fileId === last.fileId && o.at === last.at);
    const present = same.some((o) => o.present);
    const pick = (k: "pii" | "active") => same.some((o) => o[k] === true) ? true : same.some((o) => o[k] === false) ? false : null;
    return { present, pii: present ? pick("pii") : false, active: pick("active"), evidence: last.fileId, at: last.at, explicit: true, obs: last };
  }
  // No explicit observation: absence proven by the latest snapshot that covered this system without the record.
  const sys = systemOf(rid);
  const cov = world.coverage.filter((c) => c.system === sys && usable(c, auditAt) && !c.resources.has(rid))
    .sort((a, b) => a.at.localeCompare(b.at) || a.fileAt.localeCompare(b.fileAt));
  const c = cov[cov.length - 1];
  return c ? { present: false, pii: false, active: null, evidence: c.fileId, at: c.at, explicit: false, obs: null } : null;
}
