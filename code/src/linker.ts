// Stage 4 — linker: which resources belong to which person.
// 1) identity-bearing evidence (any file, any time: ownership is time-invariant)
// 2) data-catalog LINK_RESOURCE_IDENTITY activity and source_resource_id references
// 3) for records that carry no identity at all (deleted accounts, anonymized analytics), the deletion ledger:
//    each request's workflow events cluster at fixed offsets around its reported_at; attribution is a
//    one-to-one assignment across all requests so one ledger event never serves two cases.
import type { Activity, Request } from "./load.ts";
import { prefixOf } from "./evidence.ts";
import type { IdentityResolver } from "./identity.ts";
import type { World } from "./world.ts";

const minutes = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 60000;

export interface Link { resourceId: string; via: "evidence" | "catalog" | "ledger"; evidence?: string; activityId?: string; confidence: number }

export function ownership(world: World, activity: Activity[], ids: IdentityResolver): Map<string, Map<string, Link>> {
  const owned = new Map<string, Map<string, Link>>(); // user -> resource -> link
  const add = (u: string, l: Link) => { const m = owned.get(u) ?? new Map(); if (!m.has(l.resourceId)) m.set(l.resourceId, l); owned.set(u, m); };
  for (const [rid, list] of world.obs)
    for (const o of list) for (const u of o.owners) add(u, { resourceId: rid, via: "evidence", evidence: o.fileId, confidence: 1 });
  for (const a of activity) {
    if (a.event_type !== "LINK_RESOURCE_IDENTITY") continue;
    const u = a.details.match(/\buser_\d+\b/)?.[0];
    if (u && ids.people.has(u)) add(u, { resourceId: a.resource_id, via: "catalog", activityId: a.activity_id, confidence: 1 });
  }
  // search documents that point at their source account inherit the account's owner (and vice versa)
  for (const [rid, list] of world.obs)
    for (const o of list) {
      const src = o.raw.fields.source_resource_id;
      if (!src) continue;
      for (const [u, m] of owned) { if (m.has(src)) add(u, { resourceId: rid, via: "evidence", evidence: o.fileId, confidence: 0.9 }); if (m.has(rid)) add(u, { resourceId: src, via: "evidence", evidence: o.fileId, confidence: 0.9 }); }
    }
  return owned;
}

// Ledger templates: which events form a request's workflow cluster and where they sit relative to reported_at.
const STATUS_RESULT: Record<string, string> = { COMPLETE: "SUCCESS", PARTIALLY_COMPLETE: "PARTIAL", NOT_STARTED: "FAILED" };
// Two workflow generations write different messages; each sits in its own window (minutes from reported_at).
const TEMPLATES = [
  { re: /submitted primary profile/, account: [-80, -40] },
  { re: /Policy action completed/, policy: [-34, -3] }, // anonymize ~-29, redact ~-21, disable ~-15, block ~-7
  { re: /reported the requested operation as completed|completed some internal work/, account: [-15, 15], policy: [-15, 15] },
] as { re: RegExp; account?: [number, number]; policy?: [number, number] }[];
const inWindow = (a: Activity, reportedAt: string, kind: "account" | "policy") => {
  const off = minutes(a.event_time, reportedAt);
  return TEMPLATES.some((t) => t[kind] && t.re.test(a.details) && off >= t[kind]![0] && off <= t[kind]![1]);
};

export interface CaseCluster { account?: string; accountActivity?: string; tiedWith: string[]; members: Map<string, string> } // members: resource -> activity id

/**
 * Attribute ledger events to requests. Candidates come from the timing windows; resources whose owner is known
 * from evidence are only ever given to that owner; the rest are assigned one-to-one, most constrained case first.
 */
export function attributeLedger(cases: { req: Request; userId: string }[], activity: Activity[], owned: Map<string, Map<string, Link>>,
  isClean: (caseId: string) => boolean, world: World, pins = new Map<string, string>()): Map<string, CaseCluster> {
  // the account the audit can actually see: captured between the request and the audit
  const seenFor = (rid: string, r: Request) => (world.obs.get(rid) ?? []).some((o) => o.fileAt <= r.audit_at && o.at >= r.requested_at);
  const ownerOf = new Map<string, string>();
  for (const [u, m] of owned) for (const rid of m.keys()) ownerOf.set(rid, ownerOf.has(rid) && ownerOf.get(rid) !== u ? "*conflict*" : u);
  const out = new Map<string, CaseCluster>(cases.map((c) => [c.req.case_id, { tiedWith: [], members: new Map() }]));

  // --- accounts ---
  const submits = activity.filter((a) => a.event_type === "DELETE_RECORD" && a.target_system === "account_service");
  const cand = new Map<string, { a: Activity; score: number }[]>();
  for (const c of cases) {
    const list = submits
      .map((a) => ({ a, off: minutes(a.event_time, c.req.reported_at) }))
      .filter(({ a }) => inWindow(a, c.req.reported_at, "account") && (!ownerOf.has(a.resource_id) || ownerOf.get(a.resource_id) === c.userId))
      .map(({ a }) => ({ a, score: (pins.get(c.req.case_id) === a.resource_id ? 20 : 0) + (ownerOf.get(a.resource_id) === c.userId ? 10 : 0) + (seenFor(a.resource_id, c.req) ? 5 : 0) + (STATUS_RESULT[c.req.reported_status] === a.reported_result ? 2 : 0) }));
    cand.set(c.req.case_id, list.sort((x, y) => y.score - x.score || x.a.event_time.localeCompare(y.a.event_time)));
  }
  const taken = new Set<string>();
  const pending = new Set(cases.map((c) => c.req.case_id));
  // ponytail: greedy most-constrained-first assignment; exact ties fall back to case order vs event order (an
  // assumption, see README). Upgrade to Hungarian matching if candidate sets grow beyond a handful per case.
  while (pending.size) {
    let best: { id: string; pick: { a: Activity; score: number }; margin: number } | null = null;
    for (const id of pending) {
      const opts = cand.get(id)!.filter((o) => !taken.has(o.a.resource_id));
      if (!opts.length) continue;
      const margin = opts.length === 1 ? Infinity : opts[0].score - opts[1].score;
      if (!best || margin > best.margin || (margin === best.margin && id.localeCompare(best.id, undefined, { numeric: true }) < 0)) best = { id, pick: opts[0], margin };
    }
    if (!best) break;
    pending.delete(best.id);
    taken.add(best.pick.a.resource_id);
    const cl = out.get(best.id)!;
    cl.account = best.pick.a.resource_id; cl.accountActivity = best.pick.a.activity_id;
    if (best.margin === 0) cl.tiedWith = cand.get(best.id)!.filter((o) => !taken.has(o.a.resource_id) || o.a.resource_id === best!.pick.a.resource_id)
      .filter((o) => o.score === best!.pick.score).map((o) => o.a.resource_id);
  }

  // --- identity-less policy actions (anonymized analytics etc.): same timing logic, owner-known ones excluded ---
  const policy = activity.filter((a) => a.source_system === "deletion_worker" && a.target_system !== "account_service");
  const usedPolicy = new Set<string>();
  const order = [...cases].sort((x, y) => x.req.reported_at.localeCompare(y.req.reported_at) || x.req.case_id.localeCompare(y.req.case_id, undefined, { numeric: true }));
  for (const c of order) {
    const cl = out.get(c.req.case_id)!;
    for (const a of policy) {
      if (!inWindow(a, c.req.reported_at, "policy") || usedPolicy.has(a.activity_id)) continue;
      const owner = ownerOf.get(a.resource_id);
      if (owner && owner !== c.userId) continue;
      if (!owner && prefixOf(a.resource_id) !== "analytics") continue; // only analytics loses identity when compliant
      if (!owner && !isClean(c.req.case_id)) continue; // a successful anonymization belongs to a request whose other records are compliant
      if (!owner && [...cl.members.keys()].some((r) => prefixOf(r) === "analytics")) continue;
      cl.members.set(a.resource_id, a.activity_id);
      usedPolicy.add(a.activity_id);
    }
  }
  return out;
}
