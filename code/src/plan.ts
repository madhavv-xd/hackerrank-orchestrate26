// Stages 7–9 — planner (one comparator), plan simulator (apply plan, re-audit) and output validator.
import { OPERATIONS, PHASES, StepSchema, type Operation, type Step } from "./load.ts";
import type { Assessment, Treatment } from "./policy.ts";

const OP_ORDER = Object.keys(OPERATIONS) as Operation[];
const FINDING: Record<NonNullable<Assessment["violation"]>, Operation> = {
  REMAINING: "REPORT_REMAINING_RECORD", EXPOSED_PII: "REPORT_EXPOSED_PII", ACTIVE_FLOW: "REPORT_ACTIVE_DATA_FLOW", RESTORE_RISK: "REPORT_RESTORE_RISK",
};
const FIX: Record<Treatment, Operation | null> = {
  DELETE: "DELETE_RECORD", REDACT: "REDACT_RECORD", ANONYMIZE: "ANONYMIZE_RECORD", RETAIN: null, DISABLE_FLOW: "DISABLE_DATA_FLOW", BLOCK_RESTORE: "BLOCK_RESTORE",
};
const VERIFY: Record<Treatment, Operation> = {
  DELETE: "VERIFY_RECORD_ABSENT", REDACT: "VERIFY_RECORD_REDACTED", ANONYMIZE: "VERIFY_RECORD_ANONYMIZED", RETAIN: "VERIFY_RECORD_PRESENT",
  DISABLE_FLOW: "VERIFY_DATA_FLOW_DISABLED", BLOCK_RESTORE: "VERIFY_RESTORE_BLOCKED",
};

type Draft = Omit<Step, "step_no" | "phase" | "state">;
const draft = (a: Assessment, operation: Operation, evidence_id: string): Draft => ({ system_id: a.system, resource_id: a.resourceId, operation, evidence_id });

export const compareSteps = (x: Draft, y: Draft) => {
  const px = PHASES.indexOf(OPERATIONS[x.operation][0]), py = PHASES.indexOf(OPERATIONS[y.operation][0]);
  return px - py || OP_ORDER.indexOf(x.operation) - OP_ORDER.indexOf(y.operation) ||
    (x.system_id < y.system_id ? -1 : x.system_id > y.system_id ? 1 : 0) || (x.resource_id < y.resource_id ? -1 : x.resource_id > y.resource_id ? 1 : 0);
};

export function plan(assessments: Assessment[]): { status: "COMPLETE" | "INCOMPLETE"; steps: Step[] } {
  const incomplete = assessments.some((a) => a.violation);
  const drafts: Draft[] = [];
  for (const a of assessments) {
    if (a.violation) {
      drafts.push(draft(a, FINDING[a.violation], a.state.evidence));
      const fix = FIX[a.treatment];
      if (fix) drafts.push(draft(a, fix, ""));
    }
    if (incomplete || a.state.evidence) drafts.push(draft(a, VERIFY[a.treatment], incomplete ? "" : a.state.evidence));
  }
  drafts.sort(compareSteps);
  const steps = drafts.map((d, i) => StepSchema.parse({ ...d, step_no: i + 1, phase: OPERATIONS[d.operation][0], state: OPERATIONS[d.operation][1] }));
  return { status: incomplete ? "INCOMPLETE" : "COMPLETE", steps };
}

/** Apply remediation to a copy of the assessed world and re-audit: every violation must be gone. */
export function simulate(assessments: Assessment[], steps: Step[]): string[] {
  const after = assessments.map((a) => {
    const s = { ...a.state };
    for (const st of steps.filter((x) => x.phase === "REMEDIATION" && x.resource_id === a.resourceId)) {
      if (st.operation === "DELETE_RECORD") s.present = false;
      if (st.operation === "REDACT_RECORD" || st.operation === "ANONYMIZE_RECORD") s.pii = false;
      if (st.operation === "DISABLE_DATA_FLOW" || st.operation === "BLOCK_RESTORE") s.active = false;
    }
    return { ...a, state: s };
  });
  const problems: string[] = [];
  for (const a of after) {
    const s = a.state;
    if (a.treatment === "DELETE" && s.present) problems.push(`${a.resourceId} still present`);
    if ((a.treatment === "REDACT" || a.treatment === "ANONYMIZE") && s.present && s.pii) problems.push(`${a.resourceId} still identifiable`);
    if ((a.treatment === "DISABLE_FLOW" || a.treatment === "BLOCK_RESTORE") && s.present && s.active !== false) problems.push(`${a.resourceId} still active`);
    if (a.treatment === "RETAIN" && !s.present) problems.push(`${a.resourceId} retained record missing`);
    if (a.state.evidence && !steps.some((x) => x.phase === "VERIFICATION" && x.resource_id === a.resourceId)) problems.push(`${a.resourceId} not verified`);
  }
  // dependency order: flows/restores are stopped before any record they could recreate is changed
  const rem = steps.filter((x) => x.phase === "REMEDIATION");
  const lastStop = Math.max(-1, ...rem.map((x, i) => (x.operation === "DISABLE_DATA_FLOW" || x.operation === "BLOCK_RESTORE" ? i : -1)));
  const firstChange = rem.findIndex((x) => x.operation !== "DISABLE_DATA_FLOW" && x.operation !== "BLOCK_RESTORE");
  if (firstChange !== -1 && lastStop > firstChange) problems.push("record changed before data flow/restore was stopped");
  return problems;
}

export function validateRow(status: string, steps: Step[], citable: (id: string) => boolean): string[] {
  const errs: string[] = [];
  steps.forEach((s, i) => { if (s.step_no !== i + 1) errs.push(`step_no ${s.step_no} at ${i}`); StepSchema.parse(s); });
  for (let i = 1; i < steps.length; i++) if (compareSteps(steps[i - 1], steps[i]) > 0) errs.push(`order at step ${i + 1}`);
  if (status === "NOT_APPLICABLE" && steps.length) errs.push("NOT_APPLICABLE must have []");
  if (status === "COMPLETE" && steps.some((s) => s.phase !== "VERIFICATION")) errs.push("COMPLETE with non-verification steps");
  for (const s of steps) {
    const needs = s.phase === "FINDING" || status === "COMPLETE";
    if (needs && !citable(s.evidence_id)) errs.push(`step ${s.step_no} cites ${s.evidence_id || "nothing"}`);
    if (!needs && s.evidence_id !== "") errs.push(`step ${s.step_no} future work must not cite evidence`);
  }
  return errs;
}
