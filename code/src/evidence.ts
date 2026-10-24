// Stage 3 — evidence index. Every file format is reduced to the same two shapes:
//   RawRecord: one resource as seen in one file at one time (flattened scalar fields)
//   Coverage:  "this file listed system S at time T" (lets absence be proven by omission)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ManifestRow } from "./load.ts";
import { extractImage } from "./vision.ts";

export type Fields = Record<string, string | null>;
export interface RawRecord {
  fileId: string;
  fileAt: string; // manifest captured_at (citation gate)
  at: string; // when this record was observed (state gate)
  source: string; // table / section / trace id
  resourceId: string;
  fields: Fields;
  text?: string; // free text of unstructured documents
}
export interface Coverage { fileId: string; fileAt: string; at: string; system: string; source: string; resources: Set<string> }
export interface EvidenceIndex { records: RawRecord[]; coverage: Coverage[]; aliases: Map<string, string>; fileHashes: Record<string, string> }

const RID = /\b(?:account|search|support|analytics|export|backup|data_flow|audit_record|legal_hold|tombstone|marketing|object|cache|email_delivery)_\d+\b/g;
export const SYSTEM_BY_PREFIX: Record<string, string> = {
  account: "account_service", search: "search_service", support: "support_platform", analytics: "analytics_platform",
  export: "export_service", backup: "backup_service", data_flow: "integration_service", audit_record: "security_service",
  legal_hold: "legal_service", tombstone: "identity_service", marketing: "marketing_platform", object: "object_storage",
  cache: "cache_service", email_delivery: "email_delivery_service",
};
export const prefixOf = (rid: string) => rid.replace(/_\d+$/, "");
export const systemOf = (rid: string) => SYSTEM_BY_PREFIX[prefixOf(rid)] ?? "unknown";

const scalar = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === "object" ? null : String(v);

/** Scalars of a record, nested objects merged in (outer keys win); nested records with their own resource_id are skipped. */
export function flatten(obj: Record<string, unknown>): Fields {
  const fields: Fields = {};
  const flat = (o: Record<string, unknown>, nested: boolean) => {
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) { if (v.every((x) => typeof x !== "object" || x === null)) fields[k] = v.join(","); continue; }
      if (v && typeof v === "object") { if (!("resource_id" in v)) flat(v as Record<string, unknown>, true); continue; }
      if (nested && k in fields && fields[k] !== null) continue;
      fields[k] = scalar(v);
    }
  };
  flat(obj, false);
  return fields;
}

// ---------- JSON (any shape: walk objects that carry a resource_id) ----------
const TIME_KEYS = ["observed_at", "recorded_at", "captured_at", "exported_at"];
function walkJson(node: unknown, at: string, path: string, out: (rec: Omit<RawRecord, "fileId" | "fileAt">) => void, cover: (system: string, at: string, source: string, rids: string[]) => void) {
  if (Array.isArray(node)) { node.forEach((n) => walkJson(n, at, path, out, cover)); return; }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const t = TIME_KEYS.map((k) => obj[k]).find((v) => typeof v === "string") as string | undefined;
  const here = t ?? at;
  // snapshot bundle section: {data_store, records:[...]} lists everything the store held for this export
  if (typeof obj.data_store === "string" && Array.isArray(obj.records))
    cover(obj.data_store, here, `${path}/${obj.data_store}/${obj.collection ?? ""}`, (obj.records as Record<string, unknown>[]).map((r) => String(r.resource_id)));
  if (typeof obj.resource_id === "string") {
    const fields = flatten(obj);
    out({ at: here, source: path, resourceId: obj.resource_id, fields });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      // service_exports.{system}.{section}[] : each section lists the system's records
      if (path.endsWith("service_exports") && !Array.isArray(v))
        for (const items of Object.values(v as Record<string, unknown>))
          if (Array.isArray(items)) cover(k, here, `service_exports/${k}`, items.map((i) => String((i as Record<string, unknown>).resource_id)));
      walkJson(v, here, `${path}/${k}`, out, cover);
    }
  }
}

// ---------- SQL snapshots (executed with node:sqlite) ----------
function parseSql(sql: string, fileAt: string, emit: (r: Omit<RawRecord, "fileId" | "fileAt">) => void, cover: (system: string, at: string, source: string, rids: string[]) => void) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const scope = new Map<string, string>();
  if (tables.some((t) => t.name === "snapshot_scope"))
    for (const r of db.prepare("SELECT origin_system, captured_at FROM snapshot_scope").all() as { origin_system: string; captured_at: string }[]) scope.set(r.origin_system, r.captured_at);
  const perSystem = new Map<string, Set<string>>();
  const allSeen = new Set<string>();
  for (const { name } of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("resource_id")) continue;
    const bySys = new Map<string, string[]>();
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      const fields: Fields = {};
      for (const [k, v] of Object.entries(row)) if (k !== "record_json") fields[k] = scalar(v);
      if (typeof row.record_json === "string") Object.assign(fields, flatten(JSON.parse(row.record_json) as Record<string, unknown>));
      const rid = String(row.resource_id);
      const sys = fields.origin_system ?? systemOf(rid);
      emit({ at: fileAt, source: name, resourceId: rid, fields: { ...fields, table: name } });
      bySys.set(sys, [...(bySys.get(sys) ?? []), rid]);
      allSeen.add(rid);
    }
    for (const [sys, rids] of bySys) { const s = perSystem.get(sys) ?? new Set(); rids.forEach((r) => s.add(r)); perSystem.set(sys, s); }
  }
  // A point-in-time snapshot covers each system it holds (or declares in snapshot_scope) across all replica tables.
  const systems = new Set([...perSystem.keys(), ...scope.keys()]);
  for (const sys of systems) cover(sys, scope.get(sys) ?? fileAt, "sql", [...(perSystem.get(sys) ?? [])]);
  db.close();
}

// ---------- pipe-delimited handover ----------
function parseHandover(text: string, emit: (r: Omit<RawRecord, "fileId" | "fileAt">) => void) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^-\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(.*)$/);
    if (!m) continue;
    const ident = m[6].trim();
    emit({ at: m[1], source: "handover", resourceId: m[3], fields: { system: m[2], record_type: m[4], result: m[5], subject_reference: /no direct identifier/i.test(ident) ? null : ident } });
  }
}

// ---------- logs (logfmt, JSON, bracketed, syslog, pipe, cloud-runtime): group lines by trace id ----------
const KV = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|[^\s"]+)/g;
export function parseLogLine(line: string): { ts: string; trace: string | null; fields: Fields } | null {
  const ts = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/)?.[1];
  if (!ts) return null;
  const fields: Fields = {};
  const brace = line.indexOf("{");
  if (brace > 0) {
    try { for (const [k, v] of Object.entries(JSON.parse(line.slice(brace)))) fields[k] = scalar(v); } catch { /* not JSON */ }
  }
  const flat = line.replace(/\\"/g, '"');
  for (const m of flat.matchAll(KV)) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!(m[1] in fields)) fields[m[1]] = v === "null" ? null : v;
  }
  const trace = fields.trace_id ?? line.match(/\b(?:tr|rb)-[\w-]+\b/)?.[0] ?? null;
  const ev = line.match(/\]\s+([a-z_]+):/)?.[1] ?? line.match(/\|\s*([a-z_]+)\s*\|\s*instance=/)?.[1];
  if (ev && !fields.event) fields.event = ev;
  return { ts, trace, fields };
}
function parseLog(text: string, emit: (r: Omit<RawRecord, "fileId" | "fileAt">) => void) {
  const traces = new Map<string, { ts: string; fields: Fields }[]>();
  for (const line of text.split(/\r?\n/)) {
    const p = parseLogLine(line);
    if (!p) continue;
    if (p.trace && p.trace !== p.fields.instance) traces.set(p.trace, [...(traces.get(p.trace) ?? []), p]);
    else if (p.fields.resource_id) emit({ at: p.ts, source: "log", resourceId: p.fields.resource_id, fields: p.fields });
  }
  for (const [trace, lines] of traces) {
    // Lines without a resource_id (query start, cache/connection noise) only contribute who was looked up.
    const shared: Fields = {};
    for (const l of lines) for (const [k, v] of Object.entries(l.fields)) if (/key|_ref|selector|query|^service$/.test(k) && (!(k in shared) || v !== null)) shared[k] = v;
    const rids = [...new Set(lines.map((l) => l.fields.resource_id).filter((r): r is string => !!r))];
    for (const rid of rids) {
      const own = lines.filter((l) => l.fields.resource_id === rid);
      const fields: Fields = { ...shared };
      for (const l of own) Object.assign(fields, l.fields);
      emit({ at: own[own.length - 1].ts, source: trace, resourceId: rid, fields });
    }
  }
}

// ---------- PDF text layer ----------
async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 });
  const doc = await task.promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    parts.push(content.items.map((i) => ("str" in i ? i.str : "")).join("\n"));
  }
  await task.destroy();
  return parts.join("\n");
}

// Free-text documents (PDF text, screenshot transcriptions): one record per resource id or catalogued alias.
function emitFromText(text: string, at: string, source: string, aliases: Map<string, string>, emit: (r: Omit<RawRecord, "fileId" | "fileAt">) => void) {
  const rids = new Set(text.match(RID) ?? []);
  for (const [alias, rid] of aliases) if (!/^user_\d+$/.test(alias) && text.includes(alias)) rids.add(rid);
  const emails = [...new Set((text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((e) => e.toLowerCase()))];
  const users = [...new Set(text.match(/\buser_\d+\b/g) ?? [])];
  for (const rid of rids) emit({ at, source, resourceId: rid, fields: { document_emails: emails.join(",") || null, document_users: users.join(",") || null }, text });
}

export async function buildIndex(dir: string, manifest: ManifestRow[], aliases: Map<string, string>): Promise<EvidenceIndex> {
  const records: RawRecord[] = [];
  const coverage: Coverage[] = [];
  const fileHashes: Record<string, string> = {};
  for (const f of manifest) {
    const path = join(dir, f.file_path);
    const buf = readFileSync(path);
    fileHashes[f.file_id] = createHash("sha256").update(buf).digest("hex");
    const emit = (r: Omit<RawRecord, "fileId" | "fileAt">) => records.push({ ...r, fileId: f.file_id, fileAt: f.captured_at });
    const cover = (system: string, at: string, source: string, rids: string[]) =>
      coverage.push({ fileId: f.file_id, fileAt: f.captured_at, at, system, source, resources: new Set(rids) });
    const ext = f.file_path.split(".").pop()!.toLowerCase();
    if (ext === "sql") parseSql(buf.toString("utf8"), f.captured_at, emit, cover);
    else if (ext === "json") walkJson(JSON.parse(buf.toString("utf8")), f.captured_at, "", emit, cover);
    else if (ext === "log") parseLog(buf.toString("utf8"), emit);
    else if (ext === "txt") parseHandover(buf.toString("utf8"), emit);
    else if (ext === "pdf") emitFromText(await pdfText(buf), f.captured_at, "pdf", aliases, emit);
    else if (ext === "png" || ext === "jpg") {
      const img = await extractImage(buf, fileHashes[f.file_id], f.file_path);
      for (const { reference, ...rest } of img.records) {
        const rid = new RegExp(`^${RID.source}$`).test(reference) ? reference : aliases.get(reference);
        if (rid) emit({ at: f.captured_at, source: "screenshot", resourceId: rid, fields: { ...rest, reference } });
      }
    }
  }
  return { records, coverage, aliases, fileHashes };
}
