# Implementation footprint

Measured on 2026-09-29. Counts are physical TypeScript lines, including comments
and blank lines, using checked-in source rather than build output. Production
counts include `src/**/*.ts` for EmDash and `nodes/**/*.ts` plus
`credentials/**/*.ts` for n8n. Test counts include `tests/**/*.ts`, including
fixtures/helpers. Lockfiles, generated code, docs, CI, and package tooling are
excluded. These are size comparisons, not runtime performance measurements.

| Implementation                | Production LOC | Test LOC | Production modules | OpenAnalytics HTTP endpoints |
| ----------------------------- | -------------: | -------: | -----------------: | ---------------------------: |
| EmDash scaffold, PR #1        |            495 |      721 |                  9 |                            1 |
| EmDash native overview, PR #2 |           1458 |     1923 |                 10 |                            3 |
| n8n OpenAnalytics 0.1.1       |            607 |      613 |                  5 |                           11 |

PR #2 adds **963 production lines** and **1202 test lines**
over the scaffold. The scaffold tree at `a9e69a2` is identical to the original
`c7c8efe` tree. The comparison uses n8n commit
`8caaa20c6385f6fba1fcf2e8c2dbec0a1ac5efb1` from the local
`@blackswampai/n8n-nodes-openanalytics` checkout.

The EmDash plugin now owns a native admin page, public tracker insertion,
credential-bound installation snapshots, secure read transport, response
validation/projection, and useful connection/error/freshness states. The n8n
package exposes a broader set of declarative read operations through n8n's
workflow editor; it does not install a public tracker or render a site overview.
The size difference reflects those different responsibilities.

EmDash production modules remain narrowly scoped: plugin/descriptor, connection
state, configuration/settings, OpenAnalytics transport/errors/types, tracker
fragment, and one admin page. PR #2 adds no production dependencies, custom
browser bundle, chart library, application framework, polling, or shared cache.
`@emdash-cms/blocks@1.0.1` is a development dependency for type-only authoring and
upstream response validation in tests; EmDash provides its renderer at runtime.

Analytics use exactly two HTTP reads per requested overview: overview (including
its server-provided preceding-period totals) and timeseries. Revalidation adds
one site read. Public page rendering adds no read-key requests. A transient
revalidation failure returns its error and preserves a matching tracker
snapshot without starting additional analytics requests.

To reproduce the line counts, enumerate the directories above, include only
`.ts` files, and sum their physical lines. For baseline comparison, read those
same files from `git show a9e69a2:<path>`; for n8n, read files at the pinned commit.
Apply the same formatting/measurement convention in future PRs.
