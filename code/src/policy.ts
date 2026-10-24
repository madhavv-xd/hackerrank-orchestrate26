// Stage 6 — policy engine: deletion_rules.csv applied to each linked resource's state -> required treatment + gap.
import type { Activity, Rule } from "./load.ts";
import { prefixOf, systemOf } from "./evidence.ts";
import type { Observation, State } from "./world.ts";

export type Treatment = "DELETE" | "REDACT" | "ANONYMIZE" | "RETAIN" | "DISABLE_FLOW" | "BLOCK_RESTORE";
export interface Assessment {
  resourceId: string; system: string; category: string; treatment: Treatment;
  state: State; violation: null | "REMAINING" | "EXPOSED_PII" | "ACTIVE_FLOW" | "RESTORE_RISK";
}

const BASE_CATEGORY: Record<string, string> = {
  account: "USER_PROFILE", search: "SEARCH_INDEX_ENTRY", support: "SUPPORT_MESSAGE", analytics: "ANALYTICS_PROFILE",
  export: "USER_EXPORT", marketing: "MARKETING_PROFILE", audit_record: "SECURITY_AUDIT_LOG", legal_hold: "LEGAL_HOLD_RECORD",
  backup: "BACKUP_ARCHIVE", tombstone: "ACCOUNT_TOMBSTONE", object: "SUPPORT_ATTACHMENT", data_flow: "DATA_FLOW", cache: "CACHE_ENTRY",
};

/** Data category: explicit record_type in evidence wins, then what the deletion worker attempted, then the resource kind. */
export function categorize(rid: string, obs: Observation[], ledger: Activity[]): string {
  const typed = obs.map((o) => o.recordType).filter((t): t is string => !!t);
  if (typed.length) return typed[typed.length - 1];
  const base = BASE_CATEGORY[prefixOf(rid)] ?? "UNKNOWN";
  if (obs.some((o) => o.attachment)) return "SUPPORT_ATTACHMENT";
  const attempted = ledger.filter((a) => a.resource_id === rid && a.source_system === "deletion_worker").map((a) => a.event_type);
  if (attempted.includes("DELETE_RECORD") && base === "SUPPORT_MESSAGE") return "SUPPORT_ATTACHMENT";
  if (attempted.includes("DELETE_RECORD") && base === "ANALYTICS_PROFILE") return "SECONDARY_IDENTIFIER";
  return base;
}

export function treatmentFor(category: string, rules: Rule[]): Treatment {
  if (category === "DATA_FLOW") return "DISABLE_FLOW"; // processes are stopped, not stored records
  const action = rules.find((r) => r.data_category === category)?.required_action ?? "DELETE";
  if (category === "BACKUP_ARCHIVE") return "BLOCK_RESTORE"; // RETAIN when restore access can be blocked
  return action;
}

export function assess(rid: string, state: State, obs: Observation[], ledger: Activity[], rules: Rule[]): Assessment {
  const category = categorize(rid, obs, ledger);
  const treatment = treatmentFor(category, rules);
  let violation: Assessment["violation"] = null;
  if (treatment === "DELETE" && state.present) violation = "REMAINING";
  if ((treatment === "REDACT" || treatment === "ANONYMIZE") && state.present && state.pii) violation = "EXPOSED_PII";
  if (treatment === "DISABLE_FLOW" && state.present && state.active !== false) violation = "ACTIVE_FLOW";
  if (treatment === "BLOCK_RESTORE" && state.present && state.active !== false) violation = "RESTORE_RISK";
  return { resourceId: rid, system: systemOf(rid), category, treatment, state, violation };
}
