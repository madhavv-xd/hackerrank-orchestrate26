// Stage 1 — does the request authorize deletion? LLM classification (cached) with a deterministic fallback,
// cross-checked against privacy-intake CLASSIFY_REQUEST events in the activity ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./load.ts";
import { cachedStructured, type LlmClient, MODEL } from "./llm.ts";

export const IntentSchema = z.object({
  authorizes_deletion: z.boolean(),
  request_type: z.enum(["deletion", "access", "export", "correction", "marketing_opt_out", "account_support", "other"]),
  language: z.string(),
  reason: z.string(),
});
export type Intent = z.infer<typeof IntentSchema> & { source: "llm" | "rules" };
const PROMPT = readFileSync(join(REPO_ROOT, "code", "prompts", "intent.md"), "utf8");

// Fallback rules: an explicit refusal of deletion wins; otherwise a deletion verb authorizes; anything else is a
// narrower request (the label is only for the decision trace).
const REFUSAL = /\bnot (?:asking|a request) (?:for|to) (?:deletion|erase|delete)|\bdon'?t delete|\bdo not (?:close|delete)|\bkeep the account|\bleave (?:my|the) (?:profile|account)|\bcontinue using|\bwithout removing|\bmarketing lists? only/i;
const NARROWER: [RegExp, Intent["request_type"]][] = [
  [/\bmarketing lists? only|\bpromotional emails?|\bunsubscribe|\bopt[- ]?out/i, "marketing_opt_out"],
  [/\b(?:copy|download|portable|what personal information)\b/i, "access"],
  [/\b(?:misspelled|out of date|correct it|change the email|update my)\b/i, "correction"],
  [/\b(?:reset(?:ting)? the login|can'?t access)\b/i, "account_support"],
  [/\binvoices?\b|\breceipts?\b/i, "other"],
];
const DELETION = /\b(?:delet\w*|eras\w*|remov\w*|clos\w* (?:the|my|this) account|account-deletion|(?:profile|account) is gone)\b|exclus[aã]o|eliminaci[oó]n|suppression|削除|삭제/i;

export function ruleIntent(text: string): Intent {
  const m = text.match(DELETION);
  if (m && !REFUSAL.test(text)) return { authorizes_deletion: true, request_type: "deletion", language: "und", reason: m[0], source: "rules" };
  const [re, type] = NARROWER.find(([r]) => r.test(text)) ?? [REFUSAL, "other" as const];
  return { authorizes_deletion: false, request_type: type, language: "und", reason: text.match(re)?.[0] ?? "no deletion request found", source: "rules" };
}

const BatchSchema = z.object({ results: z.array(IntentSchema.extend({ id: z.number().int() })) });
export const BATCH_SIZE = 40;

/**
 * Classify all distinct request texts, BATCH_SIZE per call (398 distinct texts -> 10 calls, which fits free-tier
 * daily caps). Chunks come from the sorted distinct texts, so the cache keys are stable across runs.
 * Any text the model skipped or answered invalidly falls back to the rules.
 */
export async function classifyAll(texts: string[], client: LlmClient | null): Promise<Map<string, Intent>> {
  const distinct = [...new Set(texts)].sort();
  const out = new Map<string, Intent>();
  for (let i = 0; i < distinct.length; i += BATCH_SIZE) {
    const chunk = distinct.slice(i, i + BATCH_SIZE);
    const res = await cachedStructured(client, {
      purpose: "intent", model: MODEL, schema: BatchSchema,
      system: `${PROMPT}
You receive a JSON array of {id, text}. Classify every item independently and return \`results\` with one entry per id.`,
      content: [{ type: "text", text: JSON.stringify(chunk.map((text, id) => ({ id, text }))) }],
    });
    for (const r of res?.results ?? []) if (chunk[r.id] !== undefined) { const { id, ...intent } = r; out.set(chunk[id], { ...intent, source: "llm" }); }
  }
  for (const t of distinct) if (!out.has(t)) out.set(t, ruleIntent(t));
  return out;
}
