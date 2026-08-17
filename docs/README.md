# Public documentation guide

This public repository owns Repbook application source and durable public
contracts. It deliberately does not own private production chronology, owner
workout evidence, deployment identifiers, or roadmap priority.

## Authoritative documents

| Document | Responsibility |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | Mandatory application and data safeguards |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Current system ownership, persisted meaning, concurrency, recovery, and product contracts |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Setup, exact verification commands, and public delivery workflow |
| [`SECURITY_AND_PRIVACY.md`](SECURITY_AND_PRIVACY.md) | Public/private data boundary and security requirements |
| [`PROVENANCE.md`](PROVENANCE.md) | Relationship between sanitized public history and private operating records |
| [`repbook-v2-verification-matrix.json`](repbook-v2-verification-matrix.json) | Machine-readable verification inventory |

## What does not belong here

The following belong in the separate private operating-record repository:

- current production deployment and live migration checkpoints;
- private release ledgers and rollback evidence;
- owner field observations or workout content;
- current product priority and future roadmap decisions;
- secrets, environment values, branch IDs, and operational logs.

Public source can prove what a build contains. It cannot by itself prove which
migration is installed in production, which deployment is canonical, or which
feature should be built next.

## Historical material

Git history and tests preserve earlier contracts and release development. Do
not create public handoff or roadmap documents that duplicate the private
authorities. When a durable product invariant changes, update `ARCHITECTURE.md`;
when commands or verification change, update `DEVELOPMENT.md`.

## Verification

Run:

```bash
npm run docs:check
```

The documentation check validates public links and privacy boundaries. Broader
application changes follow the complete verification contract in
[`DEVELOPMENT.md`](DEVELOPMENT.md).
