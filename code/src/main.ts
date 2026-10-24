// CLI: `npm run audit` writes ../output.csv for dataset/deletion_requests.csv; `--samples` also scores the labelled samples.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { csvField, loadDataset, REPO_ROOT, type Step } from "./load.ts";
import { runAudit, type CaseResult } from "./audit.ts";
import { score } from "./score.ts";
import { failures, ledger, liveLlm, LLM_PROVIDER, MODEL, VISION_MODEL } from "./llm.ts";
import { anomalies, log, manifest, RUN_DIR, stageStats } from "./telemetry.ts";
import { writeUsageReport } from "./report.ts";

const ds = loadDataset();
const t0 = Date.now();
// Samples and requests share one activity ledger, so ledger attribution runs over both at once.
const results = await runAudit(ds, [...ds.samples, ...ds.requests]);
const byId = new Map(results.map((r) => [r.case_id, r]));

const rows = ds.requests.map((r) => byId.get(r.case_id)!).sort((a, b) => a.case_id.localeCompare(b.case_id, "en"));
const serialize = (steps: Step[]) => JSON.stringify(steps.map((s) => ({ step_no: s.step_no, phase: s.phase, system_id: s.system_id, resource_id: s.resource_id, operation: s.operation, state: s.state, evidence_id: s.evidence_id })));
const csv = ["case_id,deletion_status,steps_json", ...rows.map((r) => [r.case_id, r.deletion_status, serialize(r.steps)].map(csvField).join(","))].join("\n") + "\n";
if (rows.length !== ds.requests.length || new Set(rows.map((r) => r.case_id)).size !== rows.length) throw new Error("output row count mismatch");
writeFileSync(join(REPO_ROOT, "output.csv"), csv);

const gold = ds.sampleOutput.map((g) => ({ case_id: g.case_id, deletion_status: g.deletion_status, steps: JSON.parse(g.steps_json) as Step[] }));
const sampleScore = score(new Map(ds.samples.map((s) => [s.case_id, byId.get(s.case_id)!])), gold);
const summary = {
  manifest: manifest(["deletion_requests.csv", "sample_deletion_requests.csv", "system_activity.csv", "evidence_files.csv", "user_identities.csv", "user_audit_log.csv", "deletion_rules.csv"],
    { provider: LLM_PROVIDER, model: MODEL, visionModel: VISION_MODEL, liveLlm: liveLlm() }),
  wallMs: Date.now() - t0,
  statusCounts: Object.fromEntries(["COMPLETE", "INCOMPLETE", "NOT_APPLICABLE"].map((s) => [s, rows.filter((r) => r.deletion_status === s).length])),
  sampleScore: { ...sampleScore, perCase: undefined },
  stages: stageStats(),
  anomalies: Object.fromEntries(anomalies),
  llm: ledger,
  llmFailures: failures,
};
writeFileSync(join(RUN_DIR, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(RUN_DIR, "traces.json"), JSON.stringify(results.map((r: CaseResult) => ({ case_id: r.case_id, status: r.deletion_status, ...r.trace, steps: r.steps })), null, 2));
writeUsageReport(ledger, ds.requests.length, { runId: summary.manifest.runId, gitSha: summary.manifest.gitSha,
  fallbackIntents: rows.filter((r) => r.trace.intent.source === "rules").length });
log.info({ statusCounts: summary.statusCounts, sample: summary.sampleScore }, "run complete");

console.log(`output.csv: ${rows.length} rows`, summary.statusCounts);
console.log("samples:", JSON.stringify(summary.sampleScore));
if (process.argv.includes("--samples"))
  for (const c of sampleScore.perCase.filter((c) => !c.exact || c.status !== c.gold)) console.log(`  ${c.case_id} ${c.status}/${c.gold} stepF1=${c.stepF1.toFixed(2)}`);
if (failures.length) console.log(`LLM failures (fell back to rules/cache): ${failures.length}`, failures.slice(0, 3));
console.log("anomalies:", JSON.stringify(summary.anomalies), "run dir:", RUN_DIR);
