// The pipeline: intent -> identity -> evidence index -> linker -> world state -> policy -> plan -> simulate -> validate.
import type { Dataset, Request, Step } from "./load.ts";
import { buildIndex, systemOf, type EvidenceIndex } from "./evidence.ts";
import { IdentityResolver } from "./identity.ts";
import { classifyAll, type Intent } from "./intent.ts";
import { attributeLedger, ownership } from "./linker.ts";
import { AGENT_TOKEN_BUDGET, investigate, investigateCachedOnly } from "./agent.ts";
import { ledger, makeClient } from "./llm.ts";
import { assess, categorize, treatmentFor, type Assessment } from "./policy.ts";
import { plan, simulate, validateRow } from "./plan.ts";
import { anomaly, span } from "./telemetry.ts";
import { buildWorld, stateAt, usable, type World } from "./world.ts";

export interface CaseResult {
  case_id: string; deletion_status: "COMPLETE" | "INCOMPLETE" | "NOT_APPLICABLE"; steps: Step[];
  trace: { intent: Intent; userId?: string; resources: { id: string; via: string; category?: string; state?: string; evidence?: string }[]; problems: string[] };
}

export function catalogAliases(ds: Dataset) {
  const aliases = new Map<string, string>();
  for (const a of ds.activity) {
    const m = a.details.match(/(?:linked|confirmed) (\S+) \(([^)]+)\)/);
    if (a.event_type === "LINK_RESOURCE_IDENTITY" && m && m[1] !== m[2]) aliases.set(m[2], m[1]);
  }
  return aliases;
}

export async function runAudit(ds: Dataset, cases: Request[], index?: EvidenceIndex): Promise<CaseResult[]> {
  const ids = new IdentityResolver(ds.identities, ds.auditLog);
  const idx = index ?? (await span("evidence_index", () => buildIndex(ds.dir, ds.manifest, catalogAliases(ds))));
  const world: World = await span("world", () => buildWorld(idx, ids));
  const owned = await span("ownership", () => ownership(world, ds.activity, ids));
  const client = makeClient();
  const citable = (auditAt: string) => {
    const at = new Map(ds.manifest.map((m) => [m.file_id, m.captured_at]));
    return (id: string) => (at.get(id) ?? "9999") <= auditAt;
  };

  // 1-2: intent and identity
  const prepared = [];
  const intents = await span("intent", () => classifyAll(cases.map((c) => c.request_text), client));
  for (const req of cases) {
    const intent = intents.get(req.request_text)!;
    const userId = ids.resolve(req.email);
    if (intent.authorizes_deletion && !userId) anomaly("unresolved_identity", { case: req.case_id });
    // Cross-check: privacy intake may have classified this person's request as non-deletion (a claim, not proof).
    const intake = ds.activity.find((a) => a.event_type === "CLASSIFY_REQUEST" && userId && owned.get(userId)?.has(a.resource_id) &&
      a.event_time >= req.requested_at && a.event_time <= req.audit_at);
    if (intake && intent.authorizes_deletion) anomaly("intent_conflict", { case: req.case_id, activity: intake.activity_id });
    prepared.push({ req, intent, userId });
  }
  const deletion = prepared.filter((p) => p.intent.authorizes_deletion && p.userId) as { req: Request; intent: Intent; userId: string }[];

  // 4-6, first pass: evidence-linked resources and their state, so the ledger pass knows which cases are clean
  // A person with several requests: each linked record belongs to the first request audited after it was first seen.
  const casesOf = new Map<string, Request[]>();
  for (const d of deletion) casesOf.set(d.userId, [...(casesOf.get(d.userId) ?? []), d.req].sort((a, b) => a.audit_at.localeCompare(b.audit_at)));
  const homeCase = (userId: string, rid: string) => {
    const reqs = casesOf.get(userId) ?? [];
    const first = (world.obs.get(rid) ?? [])[0]?.at ?? "";
    return (reqs.find((r) => r.audit_at >= first) ?? reqs[reqs.length - 1])?.case_id;
  };
  const evidenceAssess = (req: Request, userId: string, extra: string[] = [], quiet = false) => {
    const out: Assessment[] = [];
    const mine = [...(owned.get(userId)?.keys() ?? [])].filter((rid) => homeCase(userId, rid) === req.case_id);
    const rids = new Set([...mine, ...extra]);
    for (const rid of rids) {
      const all = world.obs.get(rid) ?? [];
      const obs = all.filter((o) => usable(o, req.audit_at));
      let st = stateAt(world, rid, req.audit_at);
      // Proving absence by omission needs a reason to expect the record (a ledger event); evidence-linked records
      // first captured after the audit say nothing about this request.
      if (st && !st.explicit && !extra.includes(rid)) st = null;
      // A record the policy retains that is only captured in later files existed at audit time too
      // (ownership/retention is time-invariant); it can be verified as future work but never cited.
      if (!st?.explicit && treatmentFor(categorize(rid, all, ds.activity), ds.rules) === "RETAIN" && all.some((o) => o.present && o.at <= req.audit_at))
        st = { present: true, pii: false, active: null, evidence: "", at: req.audit_at, explicit: false, obs: null };
      if (!st) { if (all.length && !quiet) anomaly("no_state_at_audit", { case: req.case_id, rid }); continue; }
      out.push(assess(rid, st, obs, ds.activity, ds.rules));
    }
    return out;
  };
  const isClean = (caseId: string) => { const d = deletion.find((x) => x.req.case_id === caseId)!; return !evidenceAssess(d.req, d.userId, [], true).some((a) => a.violation); };
  let clusters = await span("ledger_attribution", () => attributeLedger(deletion, ds.activity, owned, isClean, world));
  // Low confidence (tied candidates): ask the investigator agent; its verified picks are pinned and attribution reruns.
  const ctx = { world, activity: ds.activity, rules: ds.rules, ids, manifestAt: new Map(ds.manifest.map((m) => [m.file_id, m.captured_at])) };
  const pins = new Map<string, string>();
  for (const d of deletion) {
    const tied = clusters.get(d.req.case_id)!.tiedWith;
    if (tied.length < 2) continue;
    anomaly("ledger_tie", { case: d.req.case_id, candidates: tied });
    // Free tiers cap tokens per day: stop live investigation past the run budget (cached decisions still apply).
    const spent = ledger.filter((e) => e.purpose === "investigator").reduce((a, e) => a + e.inputTokens + e.outputTokens, 0);
    if (spent > AGENT_TOKEN_BUDGET) { anomaly("agent_budget_exhausted", { case: d.req.case_id }); }
    const pick = spent > AGENT_TOKEN_BUDGET ? await investigateCachedOnly(d.req, tied) : await span("investigator", () => investigate(d.req, d.userId, tied, ctx));
    if (pick) pins.set(d.req.case_id, pick);
  }
  if (pins.size) clusters = await span("ledger_attribution", () => attributeLedger(deletion, ds.activity, owned, isClean, world, pins));

  const results: CaseResult[] = [];
  for (const p of prepared) {
    if (!p.intent.authorizes_deletion || !p.userId) {
      results.push({ case_id: p.req.case_id, deletion_status: "NOT_APPLICABLE", steps: [], trace: { intent: p.intent, userId: p.userId, resources: [], problems: [] } });
      continue;
    }
    const cl = clusters.get(p.req.case_id)!;
    const extra = [...(cl.account ? [cl.account] : []), ...cl.members.keys()];
    const assessments = await span("policy", () => evidenceAssess(p.req, p.userId!, extra));
    if (!assessments.some((a) => systemOf(a.resourceId) === "account_service")) anomaly("no_account", { case: p.req.case_id });
    const { status, steps } = await span("plan", () => plan(assessments));
    const problems = [...simulate(assessments, steps), ...validateRow(status, steps, citable(p.req.audit_at))];
    for (const pr of problems) anomaly("plan_problem", { case: p.req.case_id, problem: pr });
    results.push({
      case_id: p.req.case_id, deletion_status: status, steps,
      trace: {
        intent: p.intent, userId: p.userId, problems,
        resources: assessments.map((a) => ({
          id: a.resourceId, via: owned.get(p.userId!)?.get(a.resourceId)?.via ?? "ledger", category: a.category,
          state: `${a.state.present ? "present" : "absent"}${a.state.pii ? "+pii" : ""}${a.state.active === true ? "+active" : a.state.active === false ? "+inactive" : ""}`, evidence: a.state.evidence,
        })),
      },
    });
  }
  return results;
}
