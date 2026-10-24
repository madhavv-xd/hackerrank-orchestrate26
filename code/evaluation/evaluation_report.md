# Evaluation report

All numbers come from `npm run score` / `npm test` on the final code (offline run, no live model calls).

## 1. Accuracy on the 32 labelled samples

| Metric | Definition | Score |
|---|---|---|
| Case-level status accuracy | `deletion_status` equal | **32/32 = 100.0%** |
| Step precision | predicted steps (all 6 fields equal) that appear in gold, multiset | **99.47%** (189/190) |
| Step recall | gold steps reproduced exactly | **97.93%** (189/193) |
| Step F1 | | **98.69%** |
| Field-level accuracy | per position `step_no`, each of phase/system/resource/operation/state/evidence compared; missing positions count as wrong | **96.55%** |
| Sequence accuracy | status equal **and** the full ordered step list identical | **28/32 = 87.5%** |

**Honesty note on the split.** The plan was to develop on ~20 samples and hold out ~12. In practice every sample was
inspected while reverse-engineering the evidence formats, so there is no untouched holdout: treat these numbers as
development-set accuracy. No rule names a case id; tests guard that the score does not regress.

### The 4 imperfect samples

| Case | Problem | Cause |
|---|---|---|
| case_04 | missing `VERIFY_RECORD_ABSENT account_004` | `account_004` appears in no evidence file and no ledger event; nothing participant-visible links it. |
| case_18 | missing `VERIFY_RECORD_PRESENT audit_record_6645` | the id appears nowhere in `dataset/`. |
| case_20 | missing `VERIFY_RECORD_PRESENT audit_record_5569` | the id appears nowhere in `dataset/`. |
| case_23 | `account_7015` instead of `account_410` | three requests (case_23, case_547, case_548) share `reported_at` and `NOT_STARTED`; three `FAILED` account submissions sit in the window and none of the accounts appears in any evidence. A genuine three-way tie (the investigator agent is the intended tie-breaker when an API key is present). |

## 2. Full run on the 518 requests

| | Count |
|---|---|
| COMPLETE | 152 |
| INCOMPLETE | 356 |
| NOT_APPLICABLE | 10 (case_533–case_542: correction, marketing opt-out, access/export, login help) |
| Validator / simulator problems | 0 |
| Ledger ties (resolved by case-order fallback offline) | 59 cases |
| Requests without an attributable account | 10 single-evidence cases (case_33–63 family) — their only links are screenshots/PDFs and catalog events |

Invariants checked by tests on every run: 518 rows sorted by `case_id`; consecutive `step_no`; phase/operation/system/resource order;
`NOT_APPLICABLE ⇒ []`; `COMPLETE` contains only verifications that cite evidence captured ≤ `audit_at`; remediation and
INCOMPLETE verifications use `""`; the plan simulator clears every violation.

## 3. Additional evaluation cases (created by us, `test/pipeline.test.ts`)

Each case changes one input in place (so ledger attribution sees the same population) and states the expected answer
derived by hand from the evidence.

| # | Input | Expected | Result |
|---|---|---|---|
| C1 | case_21 with text *"Please don't delete anything; I only want a copy of my order history."* | `NOT_APPLICABLE`, `[]` (deletion verb negated) | pass |
| C2 | case_24 with `audit_at` moved to 2026-09-16T12:00 | first step still `REPORT_REMAINING_RECORD account_5334` citing `evidence_92` (the replica copy found on 09-15 remains the latest proof) | pass |
| C3 | case_32 (tombstone still holding name/email/phone) | tombstone gets `REPORT_EXPOSED_PII → REDACT_RECORD → VERIFY_RECORD_REDACTED`, never `DELETE_RECORD` | pass |
| C4 | every COMPLETE answer in the 518 | every verification cites a file captured ≤ `audit_at` | pass |
| M1 | case_31 with the email upper-cased | identical answer | pass |
| M2 | case_12 submitted from the historical address `minjun.kim90@gmail.com` | identical to gold | pass |
| M3 | decoy record `amara-okeke.jr@proton.me` injected into `evidence_92` | case_21 unchanged | pass |
| M4 | case_21 with `audit_at` 2026-09-15T11:00 (before `evidence_92` was captured) | no step cites `evidence_92` | pass |

## 4. Failures found and improvements made (sample score after each milestone)

| Step | Change | Status | Step F1 | Field | Sequence |
|---|---|---|---|---|---|
| M3 first end-to-end | generic parsers, identity links, policy, planner | 81.3% | 82.7% | 66.8% | 43.8% |
| intent fallback | deletion verbs incl. "remove/close the account"; explicit refusals win | 100% | 93.1% | 84.3% | 56.3% |
| linker | nested `record_json` flattening (search docs hide the email under `document`); PII inside free text (`message_text`); second ledger template ("reported the requested operation as completed", ±15 min); per-request partition for people with several requests | 100% | 97.7% | 96.3% | 81.3% |
| ledger + retention | account candidates scored by owner / seen-in-evidence / status, ties by order; retained records seen only in later exports verified as future work | 100% | 98.7% | 96.5% | 87.5% |
| log traces | a `cache_lookup result=miss` line was leaking into the record of the same trace and marking audit records absent (119 false "retained record missing" in the test set → 0) | 100% | 98.7% | 96.5% | 87.5% |
| scoping | coverage-based absence only for ledger-expected records (records first seen after the audit were getting fabricated "absent" verifications) | 100% | 98.7% | 96.5% | 87.5% |

Other failure modes found while reading the data and handled explicitly: uppercase emails in handover/backup records;
lookalike decoy emails (`*.jr@`); exports that contain rows recorded after their own `captured_at`; recreation after deletion
(found → not found → found again); replica drift (record absent in primary, alive in failover/read/regional replica);
decoy deletion workflows for people who never filed a request (10 account submissions correctly left unattributed).

## 5. Known limits

- 59 requests rely on the order tie-break for the deleted account id (status and other steps unaffected).
- The 12 single-evidence requests (screenshots/PDFs) have no ledger cluster; their deleted account cannot be identified.
- The deterministic intent fallback is tuned to the request templates seen. The LLM path is the general one, but on this
  dataset the live OpenRouter model scored below it (§6), and the updated intent prompt has not been run live.

## 6. Live LLM results (OpenRouter, `nvidia/nemotron-3.5-super-vl:free`)

These are taken from the saved run summaries; no new calls were made for this report.

| Run | Intent source | Calls | Tokens in / out | Cost | Status | Step F1 | Field | Sequence |
|---|---|---|---|---|---|---|---|---|
| `2026-10-24T19-29-20-744Z` | 7 cached + 3 live batches (1 failed: empty reply after 120 s, rules used) | 3 | 4,483 / 6,101 | $0 | 31/32 | 97.6% | 94.5% | 27/32 |
| `2026-10-24T20-02-44-097Z` | all 10 OpenRouter batches from cache | 0 | 0 / 0 | $0 | 30/32 | 96.3% | 92.8% | 25/32 |
| `2026-10-24T20-12-18-500Z` (final) | deterministic rules | 0 | 0 / 0 | $0 | **32/32** | **98.7%** | **96.5%** | **28/32** |

- Failure: Nemotron classified two follow-up messages (case_06 "…Can you remove that search result too?", case_25
  "…tell me whether the account and identifiable analytics data have already been removed.") as non-deletion, which
  made them `NOT_APPLICABLE`. In the 518-request set no status changed, but the steps of case_549 and case_550 did,
  through the one-to-one ledger attribution.
- Latency: 24–31 s per successful 40-text batch; the live run took 177 s, against about 2 s offline.
- The investigator runs over OpenRouter (59 ledger ties) were interrupted before they wrote a summary; no usage was
  recorded and no answer was cached.
- Improvement: `prompts/intent.md` now states that follow-ups of an erasure request count as deletion. That prompt
  change also invalidated the cached answers, so the final run uses the rules for all intents. This is the most
  accurate configuration measured, and it is fully reproducible offline.
