// LLM access over OpenRouter's OpenAI-compatible chat-completions API, with an on-disk response cache
// and a usage ledger. Determinism: identical (model, prompt, input) -> identical cached answer; temperature 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { REPO_ROOT } from "./load.ts";

export const CACHE_DIR = join(REPO_ROOT, "code", "cache", "llm");
// USD per 1M tokens for paid models (add one before using it). OpenRouter `:free` models cost 0.
// Unknown model -> cost reported as null, never guessed.
export const PRICES: Record<string, { input: number; output: number }> = {};

export type Content = { type: "text"; text: string } | { type: "image"; mediaType: "image/png" | "image/jpeg"; base64: string };
export interface StructuredRequest<T> {
  purpose: string; model: string; system: string; content: Content[]; schema: z.ZodType<T>;
  anyModelCache?: boolean; // key the cache on the input only (screenshot facts do not depend on which model read them)
}
export interface LedgerEntry { purpose: string; model: string; provider: string; cached: boolean; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number | null }
export interface LlmClient { readonly provider: string; structured<T>(req: StructuredRequest<T>): Promise<T> }

export const ledger: LedgerEntry[] = [];
export const failures: string[] = [];
const costOf = (model: string, i: number, o: number) => (model.endsWith(":free") ? 0 : PRICES[model] ? (i * PRICES[model].input + o * PRICES[model].output) / 1e6 : null);

const BASE_URL = "https://openrouter.ai/api/v1";
export const LLM_PROVIDER = "openrouter";
export const MODEL = process.env.GHOST_AUDIT_MODEL ?? "nvidia/nemotron-3.5-super-vl:free";
export const VISION_MODEL = process.env.GHOST_AUDIT_VISION_MODEL ?? MODEL; // must accept images
const apiKey = () => (process.env.GHOST_AUDIT_OFFLINE === "1" ? undefined : process.env.OPENROUTER_API_KEY);
export const liveLlm = () => !!apiKey();

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

/** One chat-completions call: honours 429 retry-after once (bounded), records tokens/latency/cost in the ledger. */
export async function chat(purpose: string, body: { model: string; messages: ChatMessage[]; tools?: unknown[]; max_tokens?: number }): Promise<{ message: ChatMessage; tokens: number }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` }, // key never logged
      body: JSON.stringify({ temperature: 0, max_tokens: 4000, ...body }),
    });
    if (res.status === 429 && attempt === 0) { // free tiers rate-limit per minute
      await new Promise((r) => setTimeout(r, Math.min(90, Number(res.headers.get("retry-after")) || 30) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${LLM_PROVIDER} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: { message: ChatMessage }[]; error?: { message?: string }; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (!json.choices?.length) throw new Error(`${LLM_PROVIDER} returned no choices: ${json.error?.message ?? "empty response"} (often a free-tier rate limit)`);
    const i = json.usage?.prompt_tokens ?? 0, o = json.usage?.completion_tokens ?? 0;
    ledger.push({ purpose, model: body.model, provider: LLM_PROVIDER, cached: false, inputTokens: i, outputTokens: o, latencyMs: Date.now() - t0, costUsd: costOf(body.model, i, o) });
    return { message: json.choices[0].message, tokens: i + o };
  }
}

/**
 * Structured output without relying on provider support for strict schemas (free models rarely have it):
 * the JSON schema goes into the prompt and the reply is validated with zod, one retry on invalid JSON.
 */
export const client: LlmClient = {
  provider: LLM_PROVIDER,
  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { toJSONSchema } = await import("zod");
    const system = `${req.system}\n\nReply with one JSON object only (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(toJSONSchema(req.schema))}`;
    const content = req.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image_url", image_url: { url: `data:${c.mediaType};base64,${c.base64}` } }));
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const { message } = await chat(req.purpose, { model: req.model, messages: [{ role: "system", content: system }, { role: "user", content }] });
      const text = typeof message.content === "string" ? message.content : "";
      try { const parsed = req.schema.safeParse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))); if (parsed.success) return parsed.data; lastError = parsed.error.message; }
      catch (e) { lastError = String(e); }
    }
    throw new Error(`${LLM_PROVIDER} ${req.purpose}: invalid JSON reply (${lastError.slice(0, 200)})`);
  },
};

/** Live client only when OPENROUTER_API_KEY is set; otherwise the pipeline runs on cache + deterministic fallbacks. */
export const makeClient = (): LlmClient | null => (liveLlm() ? client : null);

/** Cache wrapper: cache hit -> no call (logged as cached, zero tokens); a failed call returns null so callers fall back. */
export async function cachedStructured<T>(llm: LlmClient | null, req: StructuredRequest<T>): Promise<T | null> {
  const key = createHash("sha256")
    .update(JSON.stringify([req.anyModelCache ? "any" : req.model, req.system, req.content.map((c) => (c.type === "text" ? c.text : createHash("sha256").update(c.base64).digest("hex")))]))
    .digest("hex");
  const file = join(CACHE_DIR, `${req.purpose}-${key.slice(0, 24)}.json`);
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const hit = req.schema.safeParse(stored.output);
    if (hit.success) { ledger.push({ purpose: req.purpose, model: stored.model ?? req.model, provider: stored.provider, cached: true, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 }); return hit.data; }
  }
  if (!llm) return null;
  let out: T;
  try { out = await llm.structured(req); }
  catch (e) { failures.push(`${req.purpose}: ${String(e).slice(0, 300)}`); return null; }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ purpose: req.purpose, model: req.model, provider: llm.provider, output: out }, null, 2));
  return out;
}
