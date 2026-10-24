// Scorer: compares predictions with labelled answers (case status, step-level, field-level, sequence accuracy).
import type { Step } from "./load.ts";

export interface Row { case_id: string; deletion_status: string; steps: Step[] }
const FIELDS = ["phase", "system_id", "resource_id", "operation", "state", "evidence_id"] as const;
const key = (s: Step) => FIELDS.map((f) => s[f]).join("|");

export function score(pred: Map<string, Row>, gold: Row[]) {
  let status = 0, seq = 0, tp = 0, predN = 0, goldN = 0, fieldHits = 0, fieldSlots = 0;
  const perCase: { case_id: string; status: string; gold: string; stepF1: number; exact: boolean }[] = [];
  for (const g of gold) {
    const p = pred.get(g.case_id) ?? { case_id: g.case_id, deletion_status: "MISSING", steps: [] };
    if (p.deletion_status === g.deletion_status) status++;
    const exact = JSON.stringify(p.steps.map(key)) === JSON.stringify(g.steps.map(key));
    if (exact && p.deletion_status === g.deletion_status) seq++;
    const pool = new Map<string, number>();
    for (const s of g.steps) pool.set(key(s), (pool.get(key(s)) ?? 0) + 1);
    let hit = 0;
    for (const s of p.steps) { const k = key(s); if (pool.get(k)) { hit++; pool.set(k, pool.get(k)! - 1); } }
    tp += hit; predN += p.steps.length; goldN += g.steps.length;
    const n = Math.max(p.steps.length, g.steps.length);
    for (let i = 0; i < n; i++) for (const f of FIELDS) { fieldSlots++; if (p.steps[i] && g.steps[i] && p.steps[i][f] === g.steps[i][f]) fieldHits++; }
    const f1 = p.steps.length + g.steps.length ? (2 * hit) / (p.steps.length + g.steps.length) : 1;
    perCase.push({ case_id: g.case_id, status: p.deletion_status, gold: g.deletion_status, stepF1: f1, exact });
  }
  const P = predN ? tp / predN : 1, R = goldN ? tp / goldN : 1;
  return {
    cases: gold.length, statusAccuracy: status / gold.length, sequenceAccuracy: seq / gold.length,
    stepPrecision: P, stepRecall: R, stepF1: P + R ? (2 * P * R) / (P + R) : 0,
    fieldAccuracy: fieldSlots ? fieldHits / fieldSlots : 1, perCase,
  };
}
