# Public documentation guide

This repository owns Repbook application source and durable public contracts.
It deliberately does not own private production chronology, owner workout
evidence, deployment identifiers, or roadmap priority.

## Start here

| Document | Responsibility |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | Mandatory application and data safeguards |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Current system ownership, persisted meaning, concurrency, recovery, and product contracts |
| [`ACTIVE_WORKOUT_NORTH_STAR.md`](ACTIVE_WORKOUT_NORTH_STAR.md) | Approved active-workout visual direction, interaction contract, phased implementation plan, and acceptance bar |
| [`COACHING_PRODUCT_REQUIREMENTS.md`](COACHING_PRODUCT_REQUIREMENTS.md) | Current athlete-facing coaching and Program-change requirements |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Setup, exact verification commands, and public delivery workflow |
| [`SECURITY_AND_PRIVACY.md`](SECURITY_AND_PRIVACY.md) | Public/private data boundary and security requirements |
| [`PROVENANCE.md`](PROVENANCE.md) | Relationship between sanitized public history and private operating records |

The JSON files in this directory are supporting machine-readable contracts:
the v2 verification inventory, production performance budgets, and reviewed
dependency-audit exceptions. Their consumers and checks, rather than this
index, define their exact schemas.

## Historical implementation material

[`TRAINING_REPORTING_V2_PLAN.md`](TRAINING_REPORTING_V2_PLAN.md) is the retained
implementation and acceptance record for the implemented Training Reporting V2
package. It is not current release status or roadmap authority. Any deferral
called out in that document remains a deferral unless current source and tests
prove otherwise.

[`PROGRAM_EDITOR_MEASUREMENT_PLAN.md`](PROGRAM_EDITOR_MEASUREMENT_PLAN.md) records
the focused editor and loaded-time implementation contract and verification scope.

Git history preserves earlier contracts and delivery work. Do not add a public
handoff, current-state file, release ledger, or roadmap that competes with the
private authorities.

## Private operations boundary

The separate private operations repository owns:

- current production deployment and live migration checkpoints;
- private release ledgers and rollback evidence;
- owner field observations and workout content;
- current product priority and future roadmap decisions;
- secrets, environment values, branch identifiers, and operational logs.

Public source can prove what a build contains. It cannot by itself prove which
migration is installed in production, which deployment is canonical, or which
feature should be built next.

## Keeping documentation current

- Update `ARCHITECTURE.md` when durable product or data ownership changes.
- Keep `ACTIVE_WORKOUT_NORTH_STAR.md` aligned with approved active-workout
  direction and clearly distinguish target behaviour from implemented runtime.
- Update `COACHING_PRODUCT_REQUIREMENTS.md` when athlete-facing requirements
  change.
- Update `DEVELOPMENT.md` when setup, verification, or delivery commands change.
- Update `SECURITY_AND_PRIVACY.md` when a trust or publication boundary changes.
- Keep completed plans as clearly labelled historical records; do not rewrite
  them into current status.

Run `npm run docs:check` for documentation-link and public-privacy validation.
Application changes follow the full verification contract in
[`DEVELOPMENT.md`](DEVELOPMENT.md).
