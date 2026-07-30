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

The public `fix/pain-hold-truth` change maps the application and test changes
from private source commit
`f308ead8c8ef27430707c5aa5651b97808ccfab6`. Private release-record and
field-observation documents from that commit are not copied into the public
history.
