# ISO add-on: the catalogue

Part of plan v2 ([plan.md](plan.md)). ISO-9 (M6) ships this catalogue as code and copies it into an account; ISO-1
(M0) puts a fictional-client copy in the fixtures. **No ISO standard text goes in the repo**: clause numbers and
titles only, with summaries in our own words. ISO-9 checks every clause number and title in this file against the
published standard before seeding and corrects this file through the coordinator (plan §5.6) if one is wrong.

## 1. What is copied, when, and who writes it

- The catalogue is a versioned bundle in M6 (`apps/api/src/modules/library/iso-catalogue.ts`, beside the master
  library's `master.ts`), checked like the master library before any copy (ADR M6-0001 decision 5).
- `copyIsoCatalogue(db, accountId, requestId)` copies into the account, in its own system context:
  `IsoStandard`, `IsoClause`, `IsoReviewInputDef`, `IsoReviewOutputDef` (model.md §2), and the four STANDARD acts,
  their category and their obligations (§2, §3).
- The trigger, the marker and the "being set up" answer are in plan §4.3. Turning the add-on off and on again
  copies nothing more. A later catalogue version (for example a new edition) reaches existing accounts only through
  a later, separate copy step, which is Later.
- The STANDARD acts stay out of `copyMasterLibrary` and out of the master library bundle.

## 2. STANDARD acts: fixed values

These values are fixed so the catalogue (ISO-9), the M0 fixtures (ISO-1) and the copy agree.

| Field | Value |
|---|---|
| Act `kind` | `STANDARD` (set at insert, never changes: plan §4.4) |
| Act names | `ISO 9001 quality management`, `ISO 14001 environmental management`, `ISO 45001 occupational health and safety management`, `Integrated management system (ISO 9001, 14001, 45001)` |
| Act `shortName` | `ISO 9001`, `ISO 14001`, `ISO 45001`, `ISO IMS` (in the order of the names above) |
| Act `jurisdiction`, `stateCode`, `aliases` | `CENTRAL`, `null`, `[]` (contracts 1.7.0: a STANDARD act is CENTRAL) |
| Category | one category, `ISO management systems` |
| Obligation `jurisdiction`, `stateCode` | `CENTRAL`, `null` |
| Obligation `domain` | `OTHER` |
| Obligation `criticality` | `MEDIUM` |
| Obligation `timelineType` | `TIME_BASED` |
| Obligation `ruleStatus` | `CONFIRMED` (the instance job skips any other status) |
| Obligation `evidenceRequired` | `true`: the evidence of each instance is the record the clause asks for |
| Obligation `clauseRefs` | `{ standard: ISO_9001 \| ISO_14001 \| ISO_45001, clauseNumber }[]`, never bare numbers: 9001 8.2 and 14001 8.2 are different clauses |
| Obligation `externalRef` | `ISO-<activity key>`, for example `ISO-EMERGENCY-DRILL` |

Names are unique per firm and kind (ISO-2c changes `act_name_key` to `(firm_id, kind, name)` among non-archived
rows), so a firm's own statutory Act of the same name never blocks the copy. The copy does not insert blindly as
`copyMasterLibrary` does: it reuses a non-archived STANDARD act with the same name, and a non-archived category of the
same name whatever its origin, and creates only what is missing. M8's import matches and creates STATUTE acts only
(ISO-16): STANDARD acts are left out of the names it knows and out of its commit lookup.

Staff may edit a copied STANDARD obligation's rule, description, criticality, forms and log sheets like any library
row (the rule lives on the obligation, so a change applies to the whole account), and may add their own activities
under a STANDARD act. Nobody may change an act's kind, move an obligation between a STATUTE and a STANDARD act, or
merge acts of different kinds (M6 answers `400 VALIDATION`, ISO-9b).

## 3. Recurring activity catalogue (minimum for v1)

**Each activity is shipped exactly once.** An activity that serves one standard goes under that standard's act; one
that serves more than one goes under the integrated act. The library and the ISO screens show each activity's
standards (from `clauseRefs`). A consultant assigns to a unit the activities whose `clauseRefs` name a standard of
that unit's management system, and because each activity exists once, a 14001 + 45001 unit is assigned one emergency
drill, not two. Nothing filters or assigns activities by system automatically in v1.
Activities are assigned to units, generate instances, remind, take evidence and go through maker-checker exactly
like laws. Default rules use existing `RecurrenceRule` kinds; ISO-9 sets the exact dates and validates them with M4.

| Key | Activity | clauseRefs | Act | Default rule | Evidence (the record) |
|---|---|---|---|---|---|
| `CONTEXT-REVIEW` | Review of context and interested parties | 9001, 14001, 45001: 4.1, 4.2 | Integrated | ANNUAL | updated issues and interested-party lists (the ISO context screen) |
| `COMPLIANCE-EVALUATION` | Evaluation of compliance | 14001 9.1.2, 45001 9.1.2 | Integrated | HALF_YEARLY | evaluation record (the statutory score report can be attached) |
| `COMPETENCE-REVIEW` | Competence review: training needs and effectiveness | 9001, 14001, 45001: 7.2 | Integrated | ANNUAL | training matrix |
| `AWARENESS` | Awareness and induction | 9001, 14001, 45001: 7.3 | Integrated | HALF_YEARLY | attendance record |
| `CALIBRATION` | Calibration or verification of monitoring equipment | 9001 7.1.5, 14001 9.1.1, 45001 9.1.1 | Integrated | QUARTERLY | instrument list with calibration status |
| `EXTERNAL-PROVIDERS` | Evaluation and re-evaluation of external providers | 9001 8.4.1, 14001 8.1, 45001 8.1.4 | Integrated | ANNUAL | approved supplier list with ratings |
| `EMERGENCY-DRILL` | Emergency drill and post-drill evaluation | 14001 8.2, 45001 8.2 | Integrated | HALF_YEARLY | drill report |
| `CONTRACTOR-REVIEW` | Contractor OH&S review | 45001 8.1.4.2 | 45001 | QUARTERLY | review record |
| `WORKPLACE-INSPECTION` | Workplace inspection | 45001 9.1.1 | 45001 | MONTHLY | inspection record |
| `WORKER-CONSULTATION` | Worker consultation and participation | 45001 5.4 | 45001 | QUARTERLY | committee minutes |
| `ENV-MONITORING` | Environmental performance monitoring | 14001 9.1.1 | 14001 | MONTHLY | monitoring data |
| `CUSTOMER-SATISFACTION` | Customer satisfaction survey and analysis | 9001 9.1.2 | 9001 | ANNUAL | survey results and analysis |
| `DATA-ANALYSIS` | Analysis and evaluation of data | 9001 9.1.3 | 9001 | QUARTERLY | analysis record |

Where a statutory obligation in the master library already covers the same work (for example a safety committee
meeting or a mock drill under state factory rules), the activity's description says so, so a consultant does not
assign both. In v1 the external-provider activity carries the approved supplier list, and the competence review
carries the training matrix; a supplier register with scoring and per-person training records are Later (plan §2).
A failed instance (a drill that went wrong, an instrument out of calibration) is raised as an NC with
`sourceInstanceId` from the ISO screens (model.md §3.10).

## 4. Clause catalogue rules

- One `IsoClause` row per numbered clause and sub-clause of each standard edition, with its title and a summary in
  our own words, its parent and its shared-structure key (`hlsKey`, the clause 4 to 10 number the three standards
  share).
- **`assessable`** is false for clauses 1 to 3 and for any clause that has sub-clauses in the catalogue (for example
  "8", "8.5", "4.4" in ISO 9001), because its sub-clauses carry the requirements. Only assessable clauses get a
  checklist row and count in readiness, so nothing is counted twice.
- **`exclusionAllowed`** is true only for ISO 9001 clauses that 9001 4.3 lets an organisation determine not
  applicable, where that does not affect the conformity of products and services. The starting list: 7.1.5.2,
  8.3 and its sub-clauses (8.3.1 to 8.3.6), 8.5.3 and 8.5.5. ISO-9's thread confirms it against the standard and
  records the final list in its M6 ADR. It is never true for clauses 4 to 7.1.4, 9 or 10, and never true for any
  ISO 14001 or ISO 45001 clause: clause 1 of each allows no exclusion.
- **Climate change (Amd 1:2024).** The 4.1 summary of each standard says, in our words, that the organisation decides
  whether climate change is a relevant issue; the 4.2 summary says interested parties can have climate-related
  requirements. The system's climate decision (model.md §3.1) is the record.

## 5. Management review inputs and outputs

One key per input or output; a key shared by several standards appears once in an integrated review. Titles are ours.
`source` says which records pre-fill the review pack; `MANUAL` inputs are written by hand.

| Input key | Title (ours) | 9001 | 14001 | 45001 | Source |
|---|---|---|---|---|---|
| `PREVIOUS_ACTIONS` | Status of actions from earlier reviews | 9.3.2 a | 9.3 a | 9.3 a | PREVIOUS_ACTIONS |
| `CONTEXT_CHANGES` | Changes in external and internal issues | 9.3.2 b | 9.3 b1 | 9.3 b | CONTEXT |
| `INTERESTED_PARTIES` | Changes in interested parties' needs, compliance obligations, legal and other requirements | | 9.3 b2 | 9.3 b1, b2 | CONTEXT |
| `SIGNIFICANT_ASPECTS` | Changes in significant environmental aspects | | 9.3 b3 | | RISKS |
| `RISKS_AND_OPPORTUNITIES` | Changes in risks and opportunities | | 9.3 b4 | 9.3 b3, d6 | RISKS |
| `RISK_ACTIONS` | Effectiveness of actions on risks and opportunities | 9.3.2 e | | | RISKS |
| `CUSTOMER_SATISFACTION` | Customer satisfaction and feedback | 9.3.2 c1 | | | MANUAL |
| `OBJECTIVES` | How far the policy and objectives were met | 9.3.2 c2 | 9.3 c | 9.3 c | OBJECTIVES |
| `PROCESS_PERFORMANCE` | Process performance and conformity of products and services | 9.3.2 c3 | | | MANUAL |
| `NONCONFORMITIES` | Nonconformities and corrective actions | 9.3.2 c4 | 9.3 d1 | 9.3 d1 | NONCONFORMITIES |
| `INCIDENTS` | Incidents | | | 9.3 d1 | INCIDENTS |
| `MONITORING_RESULTS` | Monitoring and measurement results | 9.3.2 c5 | 9.3 d2 | 9.3 d2 | MANUAL |
| `COMPLIANCE_EVALUATION` | Fulfilment of compliance obligations, evaluation of compliance | | 9.3 d3 | 9.3 d3 | COMPLIANCE_EVALUATION |
| `AUDIT_RESULTS` | Audit results | 9.3.2 c6 | 9.3 d4 | 9.3 d4 | AUDIT_RESULTS |
| `EXTERNAL_PROVIDERS` | Performance of external providers | 9.3.2 c7 | | | MANUAL |
| `WORKER_CONSULTATION` | Consultation and participation of workers | | | 9.3 d5 | MANUAL |
| `RESOURCES` | Adequacy of resources | 9.3.2 d | 9.3 e | 9.3 e | MANUAL |
| `COMMUNICATIONS` | Relevant communications from interested parties, complaints included | | 9.3 f | 9.3 f | MANUAL |
| `IMPROVEMENT_OPPORTUNITIES` | Opportunities for improvement | 9.3.2 f | 9.3 g | 9.3 g | MANUAL |

| Output key | Title (ours) | 9001 | 14001 | 45001 |
|---|---|---|---|---|
| `SUITABILITY` | Conclusions on continuing suitability, adequacy and effectiveness | | 9.3 | 9.3 |
| `IMPROVEMENT` | Decisions on improvement opportunities | 9.3.3 a | 9.3 | 9.3 |
| `SYSTEM_CHANGES` | Decisions on changes to the management system | 9.3.3 b | 9.3 | 9.3 |
| `RESOURCE_NEEDS` | Resources needed | 9.3.3 c | 9.3 | 9.3 |
| `OBJECTIVES_NOT_MET` | Actions where objectives were not met | | 9.3 | 9.3 |
| `INTEGRATION` | Better integration with other business processes | | 9.3 | 9.3 |
| `STRATEGIC_DIRECTION` | Implications for the organisation's strategic direction | | 9.3 | 9.3 |
| `WORKER_COMMUNICATION` | Outputs communicated to workers and their representatives | | | 9.3 |

## 6. Editions

| Standard | Edition seeded in v1 |
|---|---|
| ISO 9001 | 2015 + Amd 1:2024 |
| ISO 14001 | 2015 + Amd 1:2024 |
| ISO 45001 | 2018 + Amd 1:2024 |

Editions are data. If a revised ISO 9001 or ISO 14001 has been published by the day ISO-9 starts, ISO-9 also seeds
that edition as a separate edition that new management systems may choose; existing systems keep theirs. Every
record keeps the clause ids of the edition it was made under. **Moving an existing system to a newer edition**
(a clause mapping, carrying assessments over, an edition-move action) **is Later**; until then a client that wants
the new edition sets up a new management system on it.
