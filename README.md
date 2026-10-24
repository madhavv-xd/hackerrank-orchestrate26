# Ghost Data Audit Agent

A deletion-audit agent for the HackerRank Orchestrate challenge **Ghost Data Still Exists**.

For every request in `dataset/deletion_requests.csv` it decides whether the person actually asked for deletion,
rebuilds who that person is (current and historical identifiers), searches all evidence (SQL snapshots, JSON, logs,
PDFs, screenshots, text records) and the global activity ledger, applies `deletion_rules.csv`, and reconstructs the
true state of every copy of their data at the case's `audit_at`. It then writes `output.csv` (repo root):

```text
case_id,deletion_status,steps_json
```

with `COMPLETE`, `INCOMPLETE` or `NOT_APPLICABLE` and an ordered `FINDING → REMEDIATION → VERIFICATION` plan.

**Results:** 32/32 correct statuses on the labelled samples, step F1 98.7%, and a clean run over all 518 requests
in about 2 seconds with no model calls (see [Results](#results)).

---

## Contents

1. [Features](#features)
2. [Quick start](#quick-start)
3. [Commands](#commands)
4. [Configuration](#configuration)
5. [How it works](#how-it-works)
6. [Results](#results)
7. [OpenRouter (live LLM) results](#openrouter-live-llm-results)
8. [Project layout](#project-layout)
9. [Testing](#testing)
10. [Key decisions](#key-decisions)
11. [Known limitations](#known-limitations)
12. [Packaging](#packaging)

---

## Features

**Request understanding**
- Intent classification: does the text authorize deletion, or is it access, export, correction, marketing opt-out
  or login help? It handles English, Portuguese, Spanish, French, Japanese and Korean.
- An LLM path (OpenRouter, structured JSON checked with zod, 40 texts per call) with a deterministic rules fallback.
  An explicit refusal ("not asking for deletion", "don't delete", "marketing lists only") beats deletion verbs.
- The decision is cross-checked against `CLASSIFY_REQUEST` events in the activity ledger; disagreements are logged.

**Identity reconstruction**
- Current snapshot plus `user_audit_log` history: every email, phone and email hash the person ever had.
- Matches must be exact (case-insensitive). Lookalike decoys such as `g.silva76.jr@…` never match `g.silva76@…`.

**Evidence ingestion (every format in `dataset/evidence/`)**
- SQL snapshots run in Node's built-in `node:sqlite`, across all replica tables (primary, regional, reporting, failover).
- JSON of any shape (any object that carries a `resource_id`), including nested `record_json`.
- Logs in 6 syntaxes (logfmt, JSON, bracketed, syslog, pipe, nested message), grouped by trace id.
- PDF text layer through `pdfjs-dist`; pipe-delimited handover text; screenshots through a vision prompt with a cache.
- A strict time gate: evidence captured after `audit_at` never sets state and is never cited.

**Linking and state**
- Records are tied to a person through identity fields, data-catalog `LINK_RESOURCE_IDENTITY` events and
  `source_resource_id` chains.
- Records with no identity left (deleted accounts, anonymized analytics) are attributed from the deletion ledger
  with a one-to-one assignment across all requests. Ties go to an investigator agent, or to a deterministic tie-break.
- The state at `audit_at` comes from the latest usable observation. It catches replica drift (gone from the
  primary, alive in a failover), recreation (found, then gone, then found again), active syncs and unsafe restores.
- Workflow statuses and `reported_result` are treated as claims, never as proof.

**Policy and planning**
- `deletion_rules.csv` is loaded as data and maps each record to one of DELETE, REDACT, ANONYMIZE, RETAIN,
  disable flow or block restore.
- Account tombstones keep the stable `user_id` while name, email, phone and hash are redacted.
- The planner disables flows and blocks restores before it changes records, and handles downstream copies before
  their sources.
- A simulator applies the plan to a copy and audits it again; every violation must clear.
- A validator checks numbering, phase order, allowed operations and states, citations at or before `audit_at`,
  and that `NOT_APPLICABLE` comes with `[]`.

**Operations**
- Deterministic: stable sorts, fixed JSON key order, `temperature: 0`, and an on-disk LLM cache, so reruns are
  byte-identical.
- Telemetry for every run in `code/runs/<run-id>/`: a manifest with the git sha, config and dataset hashes, pino
  JSONL logs, per-stage timings, anomaly counters, per-case decision traces and an LLM usage ledger.
- `evaluation/usage_report.md` is regenerated on every run from the real token ledger.

---

## Quick start

Requirements: **Node.js ≥ 22.5** (it uses `node:sqlite` and `--experimental-strip-types`; tested on 22.14). No build
step, no Python, no API key needed.

`code/` must sit next to `dataset/` (the program reads `../dataset` and writes `../output.csv`):

```text
<repo root>/
├── dataset/          ← challenge data (not part of code.zip)
├── code/             ← this project
└── output.csv        ← written here
```

```bash
cd code
npm install
npm run audit        # writes ../output.csv (518 rows) + code/runs/<run>/ + evaluation/usage_report.md
```

Expected console output:

```text
output.csv: 518 rows { COMPLETE: 152, INCOMPLETE: 356, NOT_APPLICABLE: 10 }
samples: {"cases":32,"statusAccuracy":1,"sequenceAccuracy":0.875,...,"stepF1":0.9869...,"fieldAccuracy":0.9654...}
```

To reproduce the submitted `output.csv` exactly, without any network access:

```bash
GHOST_AUDIT_OFFLINE=1 npm run audit                      # macOS / Linux / Git Bash
$env:GHOST_AUDIT_OFFLINE="1"; npm run audit              # Windows PowerShell
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run audit` | Full run: audits the 518 requests (and the 32 samples, which share the activity ledger), writes `../output.csv`, run artifacts and `evaluation/usage_report.md`. |
| `npm run score` | Same run, then lists every sample whose status or steps differ from `sample_output.csv`. |
| `npm test` | Vitest: unit tests, sample regression guard, output-contract checks, metamorphic tests and custom cases (always offline). |
| `npm run typecheck` | `tsc --noEmit` in strict mode. |
| `npm run inspect -- case case_24` | Decision trace for one case (prediction vs gold for samples). |
| `npm run inspect -- resource account_5334` | Every observation and ledger event for one resource. |

---

## Configuration

Everything is optional. Settings come from environment variables or a `.env` file at the **repo root** (template:
`../.env.example`). That file is git-ignored and sits outside `code/`, so it never ends up in `code.zip`.
`npm run audit` loads it automatically. Keys are never logged.

| Variable | Default | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | unset | Turns on live calls through OpenRouter (`https://openrouter.ai/api/v1`, OpenAI-compatible). An HTTP 429 is retried once after `retry-after`. |
| `GHOST_AUDIT_MODEL` | `nvidia/nemotron-3.5-super-vl:free` | Text model for intent and the investigator. |
| `GHOST_AUDIT_VISION_MODEL` | same as `GHOST_AUDIT_MODEL` | Image model for screenshots missing from the cache. |
| `GHOST_AUDIT_OFFLINE` | unset | `1` means no model is ever called; only the cache and deterministic fallbacks are used. |

Without a key, or with `GHOST_AUDIT_OFFLINE=1`, the run is fully deterministic and offline. Every live answer is
cached in `code/cache/llm/`, keyed on model, prompt and input, so a second run makes zero calls. Paid models are
priced from `PRICES` in `src/llm.ts`. `:free` models cost 0, and an unknown model's cost is reported as `n/a`,
never guessed.

---

## How it works

One typed module per stage in `code/src/`:

| # | Stage | Module | What it does |
|---|---|---|---|
| 0 | load | `load.ts` | RFC-4180 CSV reader; zod schema for every input row and output step. |
| 1 | intent | `intent.ts`, `prompts/intent.md` | `authorizes_deletion` from the LLM (cached) or the rules fallback; non-deletion requests become `NOT_APPLICABLE` with `[]`. |
| 2 | identity | `identity.ts` | Current and historical emails, hashes and phones per `user_id`; exact matching. |
| 3 | evidence index | `evidence.ts`, `vision.ts`, `prompts/vision.md` | Every file turns into `RawRecord {fileId, fileAt, at, resourceId, fields}` plus coverage (which system and resources a file lists, so absence can be proven). |
| 4 | linker | `linker.ts`, `agent.ts`, `prompts/investigator.md` | Ownership from identity fields, the data catalog and source links. Identity-less records are attributed from ledger windows around `reported_at`, most-constrained first; ties go to the investigator. |
| 5 | world | `world.ts` | Interprets each observation (present / PII exposed / active flow). State at `audit_at` is the latest usable observation; replicas in one snapshot are merged, since a copy anywhere keeps the record alive. |
| 6 | policy | `policy.ts` | Data category from the explicit `record_type`, else from what the deletion worker attempted, else from the resource kind. The rule says what is required, and anything else is a violation. |
| 7 | plan | `plan.ts` | Findings, remediation and verification in one comparator order (phase, operation, `system_id`, `resource_id`); a simulator and a validator check the plan. |
| 8 | output | `main.ts`, `report.ts`, `telemetry.ts` | Sorted CSV, run summary, traces and the usage report. |

**Where the LLM is used, and where it is not.** The model never writes steps. It does only three things:

1. classifies request intent,
2. transcribes screenshots into fields (checked against a zod schema),
3. picks among tied candidate accounts. It works through tools that are gated by `audit_at`
   (`lookup_identity`, `search_evidence`, `resource_timeline`, `compare_replicas`, `get_rule`), and must submit cited
   ids that are then verified. If anything fails (budget exhausted, an unknown id, a late citation, no key), the
   deterministic fallback is used.

Everything else is deterministic code.

**Output step example**

```json
{"step_no":1,"phase":"FINDING","system_id":"account_service","resource_id":"account_5334",
 "operation":"REPORT_REMAINING_RECORD","state":"PRESENT","evidence_id":"evidence_92"}
```

Findings cite the participant-visible `file_id`, `activity_id` or `audit_id`. Remediation steps and
post-remediation verifications use `""`. A `COMPLETE` case contains only verifications that cite evidence captured
at or before `audit_at`.

---

## Results

From `npm run score` on the final code, in an offline run with no model calls (run `2026-10-24T20-12-18-500Z`).
Full details are in [`evaluation/evaluation_report.md`](evaluation/evaluation_report.md).

**32 labelled samples**

| Metric | Score |
|---|---|
| Case-level status accuracy | **32/32 = 100%** |
| Step precision / recall / F1 (all 6 fields equal) | 99.47% / 97.93% / **98.69%** |
| Field-level accuracy | **96.55%** |
| Sequence accuracy (status and full step list identical) | **28/32 = 87.5%** |

The 4 samples that are not exact (case_04, case_18, case_20 and case_23) each miss a resource id that appears in no
participant-visible file, or hit a genuine three-way ledger tie.

**Full run, 518 requests**

| | Count |
|---|---|
| COMPLETE | 152 |
| INCOMPLETE | 356 |
| NOT_APPLICABLE | 10 |
| Validator / simulator problems | 0 |
| Wall time | ~2 s (offline) |
| Model calls / tokens / cost | 0 / 0 / $0 (see `evaluation/usage_report.md`) |

All samples were inspected during development, so the sample scores are development-set accuracy, not a holdout.

---

## OpenRouter (live LLM) results

The LLM path was run live against OpenRouter's free `nvidia/nemotron-3.5-super-vl:free` during development. These
numbers come from the saved run summaries in `code/runs/` (not shipped in `code.zip`); no new calls were made to
produce them.

| Run | Intent source | Model calls | Tokens (in / out) | Cost | Status acc. | Step F1 | Field acc. | Sequence acc. |
|---|---|---|---|---|---|---|---|---|
| `2026-10-24T19-29-20-744Z` (live) | 7 cached + 3 live OpenRouter batches (1 failed) | 3 | 4,483 / 6,101 | $0 | 31/32 (96.9%) | 97.6% | 94.5% | 27/32 (84.4%) |
| `2026-10-24T20-02-44-097Z` (all 10 OpenRouter batches from cache) | OpenRouter for all 398 distinct texts | 0 | 0 / 0 | $0 | 30/32 (93.8%) | 96.3% | 92.8% | 25/32 (78.1%) |
| **`2026-10-24T20-12-18-500Z` (final)** | **deterministic rules** | **0** | **0 / 0** | **$0** | **32/32 (100%)** | **98.7%** | **96.5%** | **28/32 (87.5%)** |

What happened:

- **Latency and reliability.** The two successful live batches took 31 s and 24 s each (about 5.7k and 4.9k
  tokens). The third returned an empty response after 120 s and fell back to the rules for its texts. The live run
  took 177 s in total, against about 2 s offline.
- **Accuracy.** Nemotron read two follow-up messages as non-deletion requests: case_06 ("…Can you remove that search
  result too?") and case_25 ("…tell me whether the account and identifiable analytics data have already been
  removed."). Both became `NOT_APPLICABLE` instead of `INCOMPLETE` / `COMPLETE`. In the 518-request set this did not
  change any status (still 152 / 356 / 10). Through the one-to-one ledger attribution, it did change the steps of
  case_549 and case_550.
- **Investigator agent.** The live investigator runs over OpenRouter (for the 59 ledger ties) were interrupted
  before they wrote a summary. No usage was recorded and no investigator answer was cached, so the shipped run uses
  the deterministic tie-break.
- **Response to it.** `prompts/intent.md` now states that follow-ups of an erasure request count as deletion. That
  prompt change also changed the cache key, so the 10 cached OpenRouter answers in `code/cache/llm/intent-*.json` no
  longer match. They are kept as a record of what the model answered. The updated prompt has not been run live.
- **Decision.** The final `output.csv` uses the deterministic rule intents for all 518 requests. On this dataset they
  are more accurate (32/32 vs 30–31/32), make zero calls and are reproducible byte for byte.

To try the live path yourself: put `OPENROUTER_API_KEY` in `../.env`, then run `npm run score`. The first run
classifies the 398 distinct texts in 10 calls; later runs come from the cache.

---

## Project layout

```text
code/
├── README.md                     this file
├── package.json / tsconfig.json  Node ≥ 22.5, TypeScript strict, ESM
├── src/
│   ├── main.ts                   CLI entry: run, write output.csv, summary, usage report
│   ├── load.ts                   CSV + zod schemas, paths relative to the repo root
│   ├── intent.ts                 stage 1: intent (LLM batch + rules fallback)
│   ├── identity.ts               stage 2: identity resolver
│   ├── evidence.ts               stage 3: SQL / JSON / logs / PDF / text parsers
│   ├── vision.ts, seed-vision.ts stage 3: screenshot extraction (+ cache seeding)
│   ├── linker.ts                 stage 4: record ownership and ledger attribution
│   ├── agent.ts                  stage 4: investigator agent (tool loop, verified decisions)
│   ├── world.ts                  stage 5: state at audit_at
│   ├── policy.ts                 stage 6: deletion_rules.csv to required treatment
│   ├── plan.ts                   stages 7–9: planner, simulator, validator
│   ├── audit.ts                  orchestrates the stages per case
│   ├── score.ts                  sample scorer (status, step P/R/F1, field, sequence)
│   ├── llm.ts                    OpenRouter client, cache, usage ledger
│   ├── report.ts                 writes evaluation/usage_report.md
│   ├── telemetry.ts              pino logs, spans, anomalies, run manifest
│   └── inspect.ts                case / resource debugging CLI
├── prompts/                      intent.md, investigator.md, vision.md
├── cache/llm/                    cached model answers (vision-*: 11 screenshots; intent-*: earlier OpenRouter answers)
├── test/pipeline.test.ts         15 tests
└── evaluation/
    ├── evaluation_report.md      accuracy, custom cases, failures and improvements
    └── usage_report.md           model usage of the final run (auto-generated)
```

---

## Testing

```bash
npm test          # 15 tests, ~8 s, never calls a model
npm run typecheck
```

| Group | What it guards |
|---|---|
| Units | Every log syntax parses; historical identifiers match exactly and lookalikes are rejected; the rules separate deletion from narrower requests; step ordering; investigator tools only see evidence at or before `audit_at` and only verified decisions are accepted. |
| Regression | Sample status accuracy stays at 100%; 518 valid sorted rows; nothing is cited after `audit_at`. |
| Metamorphic | An upper-cased email, a historical email, an injected decoy lookalike record, or an earlier `audit_at` each give the expected answer. |
| Custom cases C1–C4 | Deletion words inside a non-deletion request; an audit after a replica was found; a tombstone with PII is redacted, not deleted; COMPLETE answers cite only pre-audit evidence. |

---

## Key decisions

- **Time gate.** A file can define state or be cited only if its `captured_at` is at or before `audit_at`. A row
  inside it must also have been observed by then, because some exports contain later rows.
- **Ownership does not depend on time.** Which person a resource belongs to may be learned from any file, including
  later ones. Only ownership crosses the time gate: state and citations never do.
- **Ledger statuses are claims.** `reported_status` and `reported_result` only help attribute identity-less records.
  A `NOT_STARTED` request can still be `COMPLETE`.
- **Retained records seen only in later exports** are verified as future work (`""`) in `INCOMPLETE` answers, and
  never cited by a `COMPLETE` one.
- **People with several requests**: each linked record goes to the first request audited after the record was first seen.
- **The LLM never writes steps.** This keeps the output contract and its evidence citations checkable by code.

---

## Known limitations

- 59 requests rely on the deterministic order tie-break to pick the deleted account id. Their status and other steps
  are unaffected.
- About 11 single-evidence requests (screenshots and PDFs only) have no ledger cluster, so their deleted account
  cannot be identified.
- The rules fallback is tuned to the request templates in this dataset. New phrasings would need the LLM path.
- The 11 screenshot transcriptions in `cache/llm/vision-*` were made by the coding agent while building the project,
  following `prompts/vision.md`, and are tagged `manual-transcription`. Delete them and set a key to replace them
  with live extractions.

---

## Packaging

`code.zip` holds the `code/` directory only, without `node_modules/`, `runs/` or any `.env`. Unzip it at the root of
a clone of the challenge repo so that `code/` sits beside `dataset/`, then follow the [Quick start](#quick-start).
Build it from the repo root:

```bash
C:\Windows\System32\tar.exe -a -c -f code.zip --exclude "code/node_modules" --exclude "code/runs" code   # Windows
zip -r code.zip code -x "code/node_modules/*" "code/runs/*"                                             # macOS / Linux
```

On Windows, use the full path: Git Bash's own `tar` is GNU tar, which writes a plain tar even when the file name
ends in `.zip`.
