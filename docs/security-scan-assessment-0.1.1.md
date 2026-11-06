# Security scan assessment: 0.1.1

This assessment records the current interpretation of selected findings from a
Socket scan of `@jlreguera/opencode-quota@0.1.1`. It is not a complete audit or
an assertion that unlisted findings are safe. The scan is a snapshot; dependency
resolution and applicability can change independently of the plugin version.

Reviewed on 2026-11-06 against the plugin's `v0.1.1` code and the cached npm
installation on netrun with OpenCode 2.2.5. The user confirmed that the plugin
works there. The cache was inspected, but the files loaded by the running
process were not independently identified. No service restart was performed.
The cache includes `@opencode/plugin` 2.2.5, `@opentui/core` and
`@opentui/solid` 0.8.2, and `solid-js` 1.9.18. Other installations can resolve
different peer or transitive dependencies.

## Vulnerability advisories

| Finding | Assessment | Evidence and remaining work |
| --- | --- | --- |
| CVE-2026-118773 / GHSA-3g3m-2fjr-6pw4 (`glob`) | Under investigation | Versions 9.3.5, 10.5.0 and 13.0.5 are present. The `@opencode/util` wrapper does not pass an abort signal; the Babel module resolver uses synchronous globbing without an explicit signal. `rimraf` can pass glob options including a signal. These observations do not establish all reachable paths or attacker control. |
| CVE-2026-118764 / GHSA-g3hv-75wg-m249 (`minimatch`) | Under investigation | Versions 8.0.7, 9.0.9 and 10.2.5 are present. The `@opencode/util` direct match wrapper does not request optimization level 2, but `glob` 9.3.5 uses that level internally. Determine which paths execute and whether an attacker can control their patterns before concluding applicability. |

The dependency paths include `@opencode/plugin` → `@opencode/util` for
`glob` 13.0.5 and `minimatch` 10.2.5; `@opentui/solid` →
`babel-plugin-module-resolver` → `glob` 9.3.5 for `minimatch` 8.0.7; and
`@opencode/plugin` → `@opencode/ai` → Google authentication dependencies →
`rimraf` for `glob` 10.5.0 and `minimatch` 9.0.9. These paths establish
installation relationships, not execution or exploitability. Updating or
overriding transitive dependencies in the plugin is not justified by these
observations alone.

Further inspection of the cached packages found:

- `@opentui/solid/scripts/solid-transform.js` imports the Babel module
  resolver and enables it when a `resolvePath` callback is supplied. The
  resolver's `normalizeOptions.js` expands configured root directories with
  `glob.sync`; those patterns come from its Babel options. The Bun transform
  plugin can be registered as a source loader, but its activation and effective
  options in the running process were not observed. No attacker-controlled
  pattern from quota has been identified.
- `gcp-metadata`'s nested `gaxios` 7.1.3 declares `rimraf` 5.0.10. A search of
  that installed `gaxios` package found the dependency declaration but no
  JavaScript reference to `rimraf`. This is not proof that every possible
  runtime or lifecycle path is unreachable. `rimraf` itself forwards optional
  glob configuration, including a signal, to `glob`.

## Other detections

- **`seroval` 1.6.12:** present via `solid-js`. Socket describes code execution
  if untrusted input is passed to the executable `deserialize` API. The plugin
  does not directly call that API; a search of the installed Solid and OpenTUI
  Solid JavaScript did not find a direct `deserialize` reference. This does not
  prove that all indirect paths are unreachable. Applicability remains open.
- **`node-gyp` and `run-applescript`:** present in transitive dependencies.
  The reported scenarios require control of build inputs or executed scripts.
  No such flow from quota has been established; presence alone is not evidence
  of a plugin vulnerability.
- **Provider URLs:** the four reported destinations are fixed quota endpoints.
  Sending the corresponding credentials is part of the documented feature, not
  evidence of exfiltration. Redirect handling has not been fully assessed.
- **Debug output:** when explicitly enabled, the plugin writes response samples
  and request information under `/tmp/quota-samples`. Redaction preserves some
  named string fields and strings beginning with a timestamp; it is not a
  guarantee that all sensitive values are removed. Predictable paths and
  default filesystem permissions also merit review. This is a separate
  hardening concern in the plugin, not a confirmed leak. A local test of the
  actual redaction function with synthetic data confirmed that a private value
  in `display_name`, a string beginning with an ISO-like timestamp followed by
  arbitrary text, and a numeric identifier all survive. Ordinary string fields
  were replaced. Review a strict allowlist of safe values, private directory
  and file modes, and protection against pre-existing symlinks before relying on
  debug samples. No real credentials or debug samples were inspected.
- **Other capability or heuristic alerts:** not resolved by this assessment.
  Network, shell, dynamic evaluation and similar capabilities are not
  vulnerabilities without a relevant execution scenario.

## Distributed artifacts and licenses

The published npm 0.1.1 tarball was inspected by listing its entries. It
contains the plugin's three source files, package metadata, README, MIT license
and four SVG images; it does not bundle `node_modules` or native OpenTUI
artifacts. A dry run for the current checkout produced the same file list.
Dependencies and peers may still be installed separately by consumers; this
finding does not determine obligations for every downstream distribution.

The installed Linux x64 OpenTUI native package declares
`MIT AND LGPL-2.1-or-later` in npm metadata and contains multiple license files.
Its `LICENSE-STB` offers a choice between MIT and the Unlicense. This is a
direct inspection of the installed x64 artifact, not of the distinct musl and
Windows artifacts for which Socket reported an unidentified `LICENSE-STB`.
TypeScript 5.9.3 declares `Apache-2.0` in npm metadata; Socket's separate W3C
license detection has not been traced to a specific distributed file. These
facts alone do not establish an incompatibility or settle all obligations for a
separate distribution of dependencies.

## Reassessment

Revisit these findings when the plugin, OpenCode, dependencies, advisory details
or execution environment change. A machine-readable VEX statement should only
claim `not_affected` when its justification is supported for the stated product
and configuration; current CVE findings remain under investigation.
