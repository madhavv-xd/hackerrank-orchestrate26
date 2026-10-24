// Dev/interview helper.  npm run inspect -- resource <resource_id>   |   npm run inspect -- case <case_id> [...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset, REPO_ROOT } from "./load.ts";
import { buildIndex } from "./evidence.ts";
import { catalogAliases } from "./audit.ts";

const [mode, ...ids] = process.argv.slice(2);
const ds = loadDataset();
if (mode === "resource") {
  const idx = await buildIndex(ds.dir, ds.manifest, catalogAliases(ds));
  for (const id of ids) {
    for (const r of idx.records.filter((r) => r.resourceId === id)) console.log(r.fileId, "file", r.fileAt, "seen", r.at, r.source, JSON.stringify(r.fields));
    for (const a of ds.activity.filter((a) => a.resource_id === id)) console.log(a.activity_id, a.event_time, a.event_type, a.reported_result, a.details);
  }
} else {
  const dir = join(REPO_ROOT, "code", "runs");
  const last = readdirSync(dir).filter((d) => readdirSync(join(dir, d)).includes("traces.json")).sort().pop()!;
  const traces = JSON.parse(readFileSync(join(dir, last, "traces.json"), "utf8")) as any[];
  const fmt = (s: any) => `${s.phase.slice(0, 4)} ${s.operation} ${s.system_id}/${s.resource_id} ${s.evidence_id}`;
  for (const id of ids) {
    const t = traces.find((x) => x.case_id === id);
    const g = ds.sampleOutput.find((x) => x.case_id === id);
    console.log(`== ${id} user=${t.userId} pred=${t.status} gold=${g?.deletion_status ?? "n/a"} intent=${t.intent.request_type}/${t.intent.source}`);
    for (const r of t.resources) console.log("   res ", JSON.stringify(r));
    for (const s of t.steps) console.log("   pred", fmt(s));
    if (g) for (const s of JSON.parse(g.steps_json)) console.log("   gold", fmt(s));
  }
}
