// Investigator agent: called only when ledger attribution is a tie (several equally scored candidate accounts).
// It may read evidence through hard-gated tools and must answer with one of the candidates plus the ids it relied
// on; anything else (budget exhausted, unknown id, citation after audit_at, no API key) -> deterministic fallback.
// The agent never writes steps: it only pins which candidate account belongs to the request.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Activity, Request, Rule } from "./load.ts";
import { REPO_ROOT } from "./load.ts";
import type { IdentityResolver } from "./identity.ts";
import { CACHE_DIR, chat, failures, liveLlm, MODEL, type ChatMessage } from "./llm.ts";
import { usable, type World } from "./world.ts";

const PROMPT = readFileSync(join(REPO_ROOT, "code", "prompts", "investigator.md"), "utf8");
export const MAX_STEPS = 8;
export const MAX_TOKENS = 60_000;

export interface Ctx { world: World; activity: Activity[]; rules: Rule[]; ids: IdentityResolver; manifestAt: Map<string, string> }

const Inputs = {
  lookup_identity: z.object({ value: z.string() }),
  search_evidence: z.object({ text: z.string().min(3) }),
  resource_timeline: z.object({ resource_id: z.string() }),
  compare_replicas: z.object({ resource_id: z.string(), file_id: z.string() }),
  get_rule: z.object({ data_category: z.string() }),
  submit_decision: z.object({ account_id: z.string(), cited_ids: z.array(z.string()).min(1), rationale: z.string() }),
};
export type ToolName = keyof typeof Inputs;
const SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  lookup_identity: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  search_evidence: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  resource_timeline: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"], additionalProperties: false },
  compare_replicas: { type: "object", properties: { resource_id: { type: "string" }, file_id: { type: "string" } }, required: ["resource_id", "file_id"], additionalProperties: false },
  get_rule: { type: "object", properties: { data_category: { type: "string" } }, required: ["data_category"], additionalProperties: false },
  submit_decision: { type: "object", properties: { account_id: { type: "string" }, cited_ids: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["account_id", "cited_ids", "rationale"], additionalProperties: false },
};

/** Tool implementations. Every evidence read is filtered to what existed at the request's audit_at. */
export function runTool(name: ToolName, input: unknown, req: Request, ctx: Ctx): string {
  const parsed = Inputs[name].safeParse(input);
  if (!parsed.success) return `invalid input: ${parsed.error.message}`;
  const a = parsed.data as Record<string, string>;
  const visible = (rid: string) => (ctx.world.obs.get(rid) ?? []).filter((o) => usable(o, req.audit_at));
  switch (name) {
    case "lookup_identity": { const u = ctx.ids.resolve(a.value); const p = u ? ctx.ids.people.get(u)! : null; return p ? JSON.stringify({ user_id: p.userId, emails: [...p.emails], email_hashes: [...p.hashes] }) : "no exact match"; }
    case "search_evidence": {
      const hits: string[] = [];
      for (const list of ctx.world.obs.values()) for (const o of list)
        if (usable(o, req.audit_at) && JSON.stringify(o.raw.fields).toLowerCase().includes(a.text.toLowerCase())) hits.push(`${o.fileId} ${o.at} ${o.resourceId} ${JSON.stringify(o.raw.fields)}`);
      return hits.slice(0, 20).join("\n") || "no matches at or before audit_at";
    }
    case "resource_timeline": {
      const obs = visible(a.resource_id).map((o) => `${o.fileId} ${o.at} present=${o.present} pii=${o.pii} active=${o.active}`);
      const acts = ctx.activity.filter((x) => x.resource_id === a.resource_id && x.event_time <= req.audit_at).map((x) => `${x.activity_id} ${x.event_time} ${x.event_type} ${x.reported_result} (claim)`);
      return [...obs, ...acts].join("\n") || "nothing visible";
    }
    case "compare_replicas": return visible(a.resource_id).filter((o) => o.fileId === a.file_id).map((o) => `${o.raw.source}: present=${o.present} pii=${o.pii}`).join("\n") || "not in that file";
    case "get_rule": return JSON.stringify(ctx.rules.filter((r) => r.data_category === a.data_category.toUpperCase()));
    case "submit_decision": return "recorded";
  }
}

/** Accept a decision only if it names a candidate and every cited id is real and visible at audit_at. */
export function verifyDecision(d: z.infer<typeof Inputs.submit_decision>, candidates: string[], req: Request, ctx: Ctx): boolean {
  if (!candidates.includes(d.account_id)) return false;
  const actAt = new Map(ctx.activity.map((x) => [x.activity_id, x.event_time]));
  return d.cited_ids.every((id) => { const t = ctx.manifestAt.get(id) ?? actAt.get(id); return t !== undefined && t <= req.audit_at; });
}

export const AGENT_TOKEN_BUDGET = Number(process.env.GHOST_AUDIT_AGENT_TOKENS ?? 100_000); // per run, all ties together

const cacheFile = (req: Request, candidates: string[]) =>
  join(CACHE_DIR, `agent-${createHash("sha256").update(JSON.stringify([MODEL, PROMPT, req, candidates])).digest("hex").slice(0, 24)}.json`);
export async function investigateCachedOnly(req: Request, candidates: string[]): Promise<string | null> {
  const file = cacheFile(req, candidates);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).account_id ?? null : null;
}

export async function investigate(req: Request, userId: string, candidates: string[], ctx: Ctx): Promise<string | null> {
  const file = cacheFile(req, candidates);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).account_id ?? null;
  if (!liveLlm()) return null;

  const tools = (Object.keys(SCHEMAS) as ToolName[]).map((name) => ({ type: "function", function: { name, description: `${name} (see system prompt)`, parameters: SCHEMAS[name] } }));
  const messages: ChatMessage[] = [{ role: "system", content: PROMPT }, { role: "user", content:
    `Request ${req.case_id} (email ${req.email}, resolved ${userId}), reported ${req.reported_status} at ${req.reported_at}, audit_at ${req.audit_at}.
Candidate deleted accounts (equally likely from timing): ${candidates.join(", ")}.` }];
  let used = 0;
  try {
    for (let step = 0; step < MAX_STEPS && used < MAX_TOKENS; step++) {
      const { message, tokens } = await chat("investigator", { model: MODEL, messages, tools });
      used += tokens;
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (!calls.length) break;
      for (const c of calls) {
        let input: unknown;
        try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = null; }
        if (c.function.name === "submit_decision") {
          const d = Inputs.submit_decision.safeParse(input);
          const ok = d.success && verifyDecision(d.data, candidates, req, ctx);
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(file, JSON.stringify({ case_id: req.case_id, candidates, account_id: ok ? d.data.account_id : null, decision: d.success ? d.data : null, verified: ok }, null, 2));
          return ok ? d.data.account_id : null;
        }
        const name = c.function.name in SCHEMAS ? (c.function.name as ToolName) : null;
        messages.push({ role: "tool", tool_call_id: c.id, content: name ? runTool(name, input, req, ctx) : `unknown tool ${c.function.name}` });
      }
    }
  } catch (e) { failures.push(`investigator ${req.case_id}: ${String(e).slice(0, 300)}`); }
  return null; // budget exhausted, provider error or no decision -> deterministic fallback
}
