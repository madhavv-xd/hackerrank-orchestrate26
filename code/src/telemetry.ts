// Monitoring: pino JSONL log, per-stage spans (p50/p95), anomaly counters, run manifest.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import pino from "pino";
import { REPO_ROOT } from "./load.ts";

export const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
export const RUN_DIR = join(REPO_ROOT, "code", "runs", RUN_ID);
mkdirSync(RUN_DIR, { recursive: true });
export const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { run: RUN_ID } }, pino.destination({ dest: join(RUN_DIR, "run.jsonl"), sync: true }));

const timings = new Map<string, number[]>();
export const anomalies = new Map<string, number>();
export const anomaly = (kind: string, detail: Record<string, unknown>) => { anomalies.set(kind, (anomalies.get(kind) ?? 0) + 1); log.warn({ kind, ...detail }, "anomaly"); };

export async function span<T>(stage: string, fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  try { return await fn(); } finally { timings.set(stage, [...(timings.get(stage) ?? []), performance.now() - t0]); }
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export const stageStats = () => [...timings].map(([stage, xs]) => ({ stage, calls: xs.length, totalMs: xs.reduce((a, b) => a + b, 0), p50Ms: pct(xs, 0.5), p95Ms: pct(xs, 0.95) }));

export function manifest(datasetFiles: string[], config: Record<string, unknown>) {
  let gitSha = "unknown";
  try { gitSha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not a git checkout */ }
  const hashes = Object.fromEntries(datasetFiles.map((f) => [f, createHash("sha256").update(readFileSync(join(REPO_ROOT, "dataset", f))).digest("hex").slice(0, 16)]));
  return { runId: RUN_ID, gitSha, node: process.version, config, datasetHashes: hashes };
}
