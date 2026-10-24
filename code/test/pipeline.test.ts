import { beforeAll, describe, expect, it } from "vitest";
process.env.GHOST_AUDIT_OFFLINE = "1"; // tests never call a live model
import { loadDataset, type Request, type Step } from "../src/load.ts";
import { runAudit, catalogAliases, type CaseResult } from "../src/audit.ts";
import { buildIndex, parseLogLine, type EvidenceIndex } from "../src/evidence.ts";
import { IdentityResolver } from "../src/identity.ts";
import { ruleIntent } from "../src/intent.ts";
import { score } from "../src/score.ts";
import { compareSteps } from "../src/plan.ts";
import { runTool, verifyDecision, type Ctx } from "../src/agent.ts";
import { buildWorld } from "../src/world.ts";

const ds = loadDataset();
let index: EvidenceIndex;
let base: Map<string, CaseResult>;
const all = () => [...ds.samples, ...ds.requests];
/** Run the full pipeline with some requests replaced (in place, so ledger attribution sees the same population). */
async function runWith(patch: (r: Request) => Request): Promise<Map<string, CaseResult>> {
  return new Map((await runAudit(ds, all().map(patch), index)).map((r) => [r.case_id, r]));
}
const gold = (id: string) => JSON.parse(ds.sampleOutput.find((g) => g.case_id === id)!.steps_json) as Step[];
const strip = (r: CaseResult) => ({ s: r.deletion_status, steps: r.steps });

beforeAll(async () => {
  index = await buildIndex(ds.dir, ds.manifest, catalogAliases(ds));
  base = await runWith((r) => r);
}, 60_000);

describe("units", () => {
  it("parses every log syntax into fields and a trace id", () => {
    const lines = [
      `2026-09-26T07:49:50Z level=INFO service=account_service trace_id=rb-1 event=profile_lookup_completed resource_id=account_1 rows=0 http_status=404`,
      `2026-04-19T06:51:21Z {"severity":"WARN","service":"support_platform","trace_id":"tr-6093335","resource_id":"support_5609","event":"message_pii_scan","matched_value":"a@b.co"}`,
      `2026-02-28T07:57:24Z [INFO] [search_service] [tr-3561007] index_query_completed: instance="search-5" resource_id="search_2843" result="hit"`,
      `2026-08-22T10:51:52Z <14>1 node-2 account_service tr-9320077 - - level=INFO resource_id="account_9580" http_status="404"`,
      `2026-07-03T07:52:15Z | INFO | account_service | tr-9500772 | profile_lookup_completed | instance="account-6" resource_id="account_4512" rows="0"`,
      `2026-09-30T11:51:03Z requestId=tr-2263120 level=DEBUG function=profile_service message="instance=\\"profile-3\\" resource_id=\\"account_66777\\" rows=\\"1\\""`,
    ];
    for (const l of lines) {
      const p = parseLogLine(l)!;
      expect(p.trace).toMatch(/^(tr|rb)-/);
      expect(p.fields.resource_id).toMatch(/^[a-z]+_\d+$/);
    }
  });

  it("resolves historical identifiers exactly and rejects lookalikes", () => {
    const ids = new IdentityResolver(ds.identities, ds.auditLog);
    expect(ids.resolve("MINJUN.KIM90@gmail.com")).toBe("user_12"); // historical, case-insensitive
    expect(ids.resolve("44a65154bfd8e408852578fbd76813d094d1944f255ac1769ee81ba90492f10e")).toBe("user_12"); // old hash
    expect(ids.resolve("g.silva76@gmail.com")).toBe("user_13");
    expect(ids.resolve("g.silva76.jr@gmail.com")).toBeUndefined();
  });

  it("fallback intent separates deletion from narrower requests", () => {
    for (const t of ["Please remove me from marketing lists only. I still want receipts and service messages for this account.",
      "Can you tell me what personal information you hold about me? This is an information request, not a request to erase it.",
      "Please change the email address used for this account. I want to continue using the service."])
      expect(ruleIntent(t).authorizes_deletion).toBe(false);
    for (const t of ["Solicito a exclusão permanente da conta associada a este e-mail.", "このメールアドレスに関連するアカウントの完全な削除を依頼します。",
      "I closed my account, but an old “download your data” link still works. Please delete that export file as well."])
      expect(ruleIntent(t).authorizes_deletion).toBe(true);
  });

  it("orders steps by phase, operation, system, resource", () => {
    const s = (operation: Step["operation"], system_id: string, resource_id: string) => ({ operation, system_id, resource_id, evidence_id: "" });
    const sorted = [s("VERIFY_RECORD_ABSENT", "search_service", "search_1"), s("DELETE_RECORD", "search_service", "search_1"),
      s("DISABLE_DATA_FLOW", "integration_service", "data_flow_1"), s("REPORT_REMAINING_RECORD", "search_service", "search_1"),
      s("VERIFY_RECORD_ABSENT", "account_service", "account_1")].sort(compareSteps).map((x) => x.operation);
    expect(sorted).toEqual(["REPORT_REMAINING_RECORD", "DISABLE_DATA_FLOW", "DELETE_RECORD", "VERIFY_RECORD_ABSENT", "VERIFY_RECORD_ABSENT"]);
  });
});

describe("investigator agent tools (no live model)", () => {
  it("only reads evidence available at audit_at and only accepts verified decisions", () => {
    const ids = new IdentityResolver(ds.identities, ds.auditLog);
    const ctx: Ctx = { world: buildWorld(index, ids), activity: ds.activity, rules: ds.rules, ids, manifestAt: new Map(ds.manifest.map((m) => [m.file_id, m.captured_at])) };
    const req = ds.samples.find((r) => r.case_id === "case_26")!; // audit 2026-09-15T12:00
    expect(runTool("resource_timeline", { resource_id: "account_5684" }, req, ctx)).not.toContain("evidence_02"); // captured 09-17
    expect(runTool("search_evidence", { text: "almeida.mariana" }, req, ctx)).not.toContain("evidence_02");
    const ok = { account_id: "account_5684", cited_ids: ["evidence_92"], rationale: "404 in export" };
    expect(verifyDecision(ok, ["account_5684", "account_3136"], req, ctx)).toBe(true);
    expect(verifyDecision({ ...ok, account_id: "account_1" }, ["account_5684"], req, ctx)).toBe(false); // not a candidate
    expect(verifyDecision({ ...ok, cited_ids: ["evidence_02"] }, ["account_5684"], req, ctx)).toBe(false); // cited after audit
  });
});

describe("sample scorer (regression guard)", () => {
  it("keeps sample accuracy", () => {
    const g = ds.sampleOutput.map((o) => ({ case_id: o.case_id, deletion_status: o.deletion_status, steps: JSON.parse(o.steps_json) }));
    const s = score(base, g);
    expect(s.statusAccuracy).toBe(1);
    expect(s.stepF1).toBeGreaterThan(0.98);
  });
  it("produces one valid row per request, cites nothing after audit_at", () => {
    const at = new Map(ds.manifest.map((m) => [m.file_id, m.captured_at]));
    for (const r of ds.requests) {
      const out = base.get(r.case_id)!;
      expect(out).toBeDefined();
      for (const s of out.steps) if (s.evidence_id) expect(at.get(s.evidence_id)! <= r.audit_at).toBe(true);
      expect(out.trace.problems).toEqual([]);
    }
  });
});

describe("metamorphic", () => {
  it("email case does not matter", async () => {
    const out = await runWith((r) => (r.case_id === "case_31" ? { ...r, email: r.email.toUpperCase() } : r));
    expect(strip(out.get("case_31")!)).toEqual(strip(base.get("case_31")!));
  });
  it("historical email gives the same answer as the current one", async () => {
    const out = await runWith((r) => (r.case_id === "case_12" ? { ...r, email: "minjun.kim90@gmail.com" } : r));
    expect(out.get("case_12")!.steps).toEqual(gold("case_12"));
  });
  it("decoy lookalike evidence is ignored", async () => {
    const decoy = { fileId: "evidence_92", fileAt: "2026-09-15T11:44:55Z", at: "2026-09-15T10:00:00Z", source: "decoy", resourceId: "search_99999",
      fields: { email: "amara-okeke.jr@proton.me", resource_id: "search_99999" } };
    index.records.push(decoy);
    try {
      const out = await runWith((r) => r);
      expect(strip(out.get("case_21")!)).toEqual(strip(base.get("case_21")!));
    } finally { index.records.pop(); }
  });
  it("an earlier audit_at cannot see the later snapshot", async () => {
    const out = await runWith((r) => (r.case_id === "case_21" ? { ...r, audit_at: "2026-09-15T11:00:00Z" } : r));
    expect(out.get("case_21")!.steps.some((s) => s.evidence_id === "evidence_92")).toBe(false);
  });
});

describe("custom evaluation cases", () => {
  it("C1: deletion words inside a non-deletion request -> NOT_APPLICABLE", async () => {
    const out = await runWith((r) => (r.case_id === "case_21" ? { ...r, request_text: "Please don't delete anything; I only want a copy of my order history." } : r));
    expect(out.get("case_21")).toMatchObject({ deletion_status: "NOT_APPLICABLE", steps: [] });
  });
  it("C2: audit after the account replica was found -> account reported with its evidence", async () => {
    // case_24's account still answers in the 09-15 service export; moving the audit forward keeps that finding.
    const out = await runWith((r) => (r.case_id === "case_24" ? { ...r, audit_at: "2026-09-16T12:00:00Z" } : r));
    expect(out.get("case_24")!.steps[0]).toMatchObject({ operation: "REPORT_REMAINING_RECORD", resource_id: "account_5334", evidence_id: "evidence_92" });
  });
  it("C3: tombstone that still holds PII is redacted, not deleted", () => {
    const c = base.get("case_32")!;
    expect(c.steps.filter((s) => s.resource_id.startsWith("tombstone_")).map((s) => s.operation))
      .toEqual(["REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"]);
  });
  it("C4: COMPLETE needs every verification to cite pre-audit evidence", () => {
    for (const r of base.values()) if (r.deletion_status === "COMPLETE") for (const s of r.steps) expect(s.evidence_id).not.toBe("");
  });
});
