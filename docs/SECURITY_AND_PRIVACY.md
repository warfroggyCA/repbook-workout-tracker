# Security and public privacy boundary

The repository is public, but the application is designed for private workout
data.

## Safe to publish

- application source and additive migrations
- synthetic tests and fixtures
- public architecture and development contracts
- pull-request verification that uses local, disposable databases

## Kept private

- real workout or health observations
- owner names, email addresses, exports, screenshots, and account metadata
- production response bodies, maintenance counts, and exact operational times
- secrets, OAuth credentials, database URLs, snapshot keys, and provider tokens
- deployment identifiers, database branch identifiers, retained checkpoints,
  and detailed release chronology

Production-maintenance workflows intentionally remain in the private operations
repository. Public Actions must not call production maintenance endpoints.

## Application rules

Secrets remain server-only. Authenticated resources enforce ownership on the
server. User-specific responses are not shared-cacheable. Logs and client error
messages are redacted. Imports, exports, snapshots, restore, archive, and
permanent deletion validate authorization and preserve audit boundaries.

Security reports use the private process in `SECURITY.md`; public issues must
contain synthetic data only.
