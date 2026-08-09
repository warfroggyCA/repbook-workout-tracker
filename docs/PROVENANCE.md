# Sanitized source provenance

This public repository begins from a clean source snapshot of private commit
`765f11e5a156b3fef6b3b42638cadce1bc847769`.

The snapshot intentionally replaces the private repository’s chronology rather
than rewriting or publishing it. Public-bootstrap changes are limited to:

- omitting private operational, release, napkin, field-observation, and archive
  documents;
- omitting production-maintenance workflows and their logs;
- replacing owner-identifying demo and test values with synthetic values;
- replacing private documentation checks with public documentation and privacy
  checks; and
- omitting tests whose only purpose was to verify private remediation evidence
  files and private production-maintenance workflow definitions.

Application source, schema, migrations, and runtime tests otherwise come from
the mapped private commit. Future public changes are reviewed normally through
protected pull requests.

Owner-generated analysis exports carry their own package, schema, semantic,
canonicalization, and digest versions plus stable source IDs and revisions.
These package-level bindings establish which retained facts were selected; they
do not convert external or calculated material into performed evidence, an
owner decision, or an accepted Program adaptation.

Selected A05 external-analysis material retains a separate
`external-analysis-import/1` receipt with the exact package and response
digests, response identity, source bindings, selected IDs, and explicit
proposal-to-recommendation mapping. Imported observations and proposals stay
labelled external. The raw response and unselected content are not retained.
Only a later explicit owner action creates a decision; accepting creates a
future Review-direction adaptation with `programChanged: false`, not a
performed fact or published Program version.

The A06 adversarial corpus contains synthetic transformations of the public A03
response fixture only. Its declared oracles are test evidence, not imported
training evidence, model-quality claims, owner decisions, or release records.
No real provider output or private operating chronology is included.

The Gauntlet C workflow fixture contains independently generated synthetic
chat-paste and file-upload responses bound at test time to a disposable A01
package. It is public verification evidence only. It includes no provider or
owner identity and does not assert that model advice is generally reliable.

The first public `fix/pain-hold-truth` commit maps the application and test
changes from private source commit
`f308ead8c8ef27430707c5aa5651b97808ccfab6`. Private release-record and
field-observation documents from that commit are not copied into the public
history. Follow-up review fixes are native public commits and are reviewed,
tested, and released through this repository’s protected pull-request path.
