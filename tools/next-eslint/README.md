# RepBook Next lint tooling

This private, repository-local maintenance fork derives from the MIT-licensed
eslint-config-next and @next/eslint-plugin-next 16.4.2 packages. It is not an
upstream release or a package alias. No package is published.

All 22 upstream rule implementations, recommended and Core Web Vitals severities,
React, hooks, TypeScript, accessibility, import, parser and resolver configuration
remain intact. upstream.json records verified npm tarball integrity and original
file digests. The changed files are explicitly listed there. License terms are in
[LICENSE.md](LICENSE.md).

## Root discovery boundary

RepBook is one Next application at the lint working directory. The upstream
default [context.cwd] is unchanged. Explicit settings.next.rootDir supports
existing literal directories, relative or absolute, and arrays of them. Directory
symlinks and backslash path separators are supported. Missing/file roots return
no directory; nonstring array entries are ignored, as upstream does.

Glob and empty-string roots throw a clear configuration error. These are not
silently ignored or interpreted as another root. Monorepo root globs are not a
supported feature of this project-specific fork. Adding them requires a new
compatible implementation and review. This explicit restriction removes the
unused glob parser and its vulnerable development-only dependency rather than
turning off a lint rule or hiding an audit warning.

## Maintenance

When updating Next.js, compare the new upstream config and every rule with this
fork. Keep the pinned source provenance and all compatibility/security tests
current. Return to upstream tooling when a compatible release removes the
vulnerable dependency. Run npm run lint, the tooling regression tests, full
dependency audits and the application checks before accepting an update.
