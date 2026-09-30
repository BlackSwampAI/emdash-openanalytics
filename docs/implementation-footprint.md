# Implementation footprint

Measured on 2026-09-29. Counts are physical TypeScript lines, including comments
and blank lines, using checked-in source rather than build output. Production
counts include `src/**/*.ts` for EmDash and `nodes/**/*.ts` plus
`credentials/**/*.ts` for n8n. Test counts include `tests/**/*.ts`, including
fixtures/helpers. Lockfiles, generated code, docs, CI, and package tooling are
excluded. These are size comparisons, not runtime performance measurements.

| Implementation                  | Production LOC | Test LOC | Production modules | OpenAnalytics HTTP endpoints |
| ------------------------------- | -------------: | -------: | -----------------: | ---------------------------: |
| EmDash scaffold, PR #1          |            495 |      721 |                  9 |                            1 |
| EmDash native overview, PR #2   |           1458 |     1923 |                 10 |                            3 |
| EmDash pages and sources, PR #3 |           1770 |     2423 |                 14 |                            5 |
| EmDash 0.1.0 release candidate  |           1903 |     2711 |                 14 |                            5 |
| n8n OpenAnalytics 0.1.1         |            607 |      613 |                  5 |                           11 |

PR #2 adds **963 production lines** and **1202 test lines**
over the scaffold. The scaffold tree at `a9e69a2` is identical to the original
`c7c8efe` tree. The comparison uses n8n commit
`8caaa20c6385f6fba1fcf2e8c2dbec0a1ac5efb1` from the local
`@blackswampai/n8n-nodes-openanalytics` checkout.

PR #3 adds **312 production lines** and **500 test lines** over merged PR #2
(`2865caa`). It supports site metadata, overview, timeseries, pages, and sources.
The admin coordinator delegates range handling, connection blocks, overview/chart
rendering, and report tables to four small modules. Successful sections remain
visible when another read fails.

The release candidate is `@blackswampai/emdash-plugin-openanalytics`, from
`BlackSwampAI/emdash-plugin-openanalytics`, with native plugin ID `openanalytics`.
Release hardening adds automatic first-load validation, connection controls apart
from the date range, bounded upstream responses and route bodies, package checks,
and a form-driven screenshot setup. It adds no analytics reports or endpoints.
A fresh connection adds one site read before the existing four analytics reads;
matching snapshots skip that site read on revisits and range changes. Failed
configuration fingerprints require an explicit connection retry.

The EmDash plugin now owns a native admin page, public tracker insertion,
credential-bound installation snapshots, secure read transport, response
validation/projection, and useful connection/error/freshness states. The n8n
package exposes a broader set of declarative read operations through n8n's
workflow editor; it does not install a public tracker or render a site overview.
The size difference reflects those different responsibilities.

EmDash production modules remain narrowly scoped: plugin/descriptor, connection
state, configuration/settings, OpenAnalytics transport/errors/types, tracker
fragment, and native admin modules. PR #3 adds no production dependencies, custom
browser bundle, chart library, application framework, polling, or shared cache.
`@emdash-cms/blocks@1.0.1` is a development dependency for type-only authoring and
upstream response validation in tests; EmDash provides its renderer at runtime.

Analytics use exactly four HTTP reads per interaction: overview (including
its server-provided preceding-period totals), timeseries, pages, and sources.
All reuse one requested interval and timezone. Pages and sources each request
the first ten rows ranked by views. Revalidation adds
one site read. Public page rendering adds no read-key requests. A transient
revalidation failure returns its error and preserves a matching tracker
snapshot without starting additional analytics requests.

To reproduce the line counts, enumerate the directories above, include only
`.ts` files, and sum their physical lines. For baseline comparison, read those
same files from `git show a9e69a2:<path>`; for n8n, read files at the pinned commit.
Apply the same formatting/measurement convention in future PRs.

| Implementation          | Runtime dependencies | Development dependencies | Host peer      |
| ----------------------- | -------------------: | -----------------------: | -------------- |
| EmDash PR #2            |                    0 |                        8 | `emdash`       |
| EmDash PR #3            |                    0 |                       14 | `emdash`       |
| n8n OpenAnalytics 0.1.1 |                    0 |                        7 | `n8n-workflow` |

PR #3 adds only development tooling: Astro, its Node and React adapters and React peers
for EmDash's host admin, and Playwright. The plugin still uses native Block Kit
and has no browser entrypoint. The React dependencies serve EmDash itself in
the demo; they add no React application to the plugin. The demo runs an actual
EmDash instance with an isolated temporary SQLite database and a loopback
OpenAnalytics HTTP fixture. Screenshots come from its authenticated admin page
and are checked for credential exposure before being retained. Demo code and
screenshots are excluded from npm.

Package sizes are measured with `npm pack --ignore-scripts --dry-run --json`
after building; packed size is the compressed tarball, not dependency install
size. EmDash PR #3 packs to **about 23.7 kB** (decimal), compared with
**19.3 kB** for PR #2. The existing n8n checkout at the pinned commit packs to
**8,919 bytes**.
Its package includes compiled workflow operations, source maps, and icons; the
EmDash package includes the compiled plugin, declarations, README, and two
contract/footprint documents. Package size reflects those different contents.
The current 0.1.0 release candidate packs to approximately **26.3 kB** (decimal).
