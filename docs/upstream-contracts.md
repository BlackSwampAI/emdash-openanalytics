# Verified upstream contracts

## Release naming and current native-plugin contract (2026-09-29)

Before the release naming change, I rechecked the current EmDash upstream
`main` ref with `git ls-remote`: `54209bc9bd0b48e12bdefa8ac971da01ced7990f`.
This is the pinned upstream revision for the release-convention check. A direct
source clone was unavailable, so I used GitHub's public API to read the relevant
source files at this exact commit.

The current [native plugin distribution guide](https://docs.emdashcms.com/plugins/creating-native-plugins/distributing/)
explicitly says `definePlugin()` accepts a simple unscoped ID of lowercase
letters, digits, and hyphens, and recommends that form because an ID occupies
one route path segment. It separately shows a scoped npm entrypoint. Therefore
`@blackswampai/emdash-plugin-openanalytics` as the npm package and `openanalytics`
as the native plugin ID follow the upstream recommendation; the package scope
does not need to be repeated in the plugin ID. Current EmDash packages such as
`@emdash-cms/plugin-audit-log` also use `plugin-` in their package name, while
the official distribution guide documents that package identity and plugin ID
are distinct values. No current EmDash technical constraint argues against the
requested Black Swamp AI package family. At the pinned revision,
[`packages/plugins/audit-log/package.json`](https://github.com/emdash-cms/emdash/blob/54209bc9bd0b48e12bdefa8ac971da01ced7990f/packages/plugins/audit-log/package.json)
is named `@emdash-cms/plugin-audit-log`; the native Color example uses
`id: "color"` in
[`packages/plugins/color/src/index.ts`](https://github.com/emdash-cms/emdash/blob/54209bc9bd0b48e12bdefa8ac971da01ced7990f/packages/plugins/color/src/index.ts).
The route-segment recommendation appears in the
[current native distribution guide](https://docs.emdashcms.com/plugins/creating-native-plugins/distributing/).

The current [native generated-settings documentation](https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/)
describes `admin.settingsSchema` as the generated form contract. The [official
hook reference](https://docs.emdashcms.com/reference/hooks/) documents plugin
lifecycle, content, media, and public-page hooks; it does not define a settings
save callback. Likewise, the current [hook guide](https://docs.emdashcms.com/plugins/creating-plugins/hooks/)
says hooks are declared at plugin definition time, with `content:afterSave`
being explicitly a content-save hook. There is no documented native settings
`afterSave`/`onSave` extension point to validate credentials after a generated
settings form save. The pinned handler source,
[`packages/core/src/api/handlers/plugin-settings.ts`](https://github.com/emdash-cms/emdash/blob/54209bc9bd0b48e12bdefa8ac971da01ced7990f/packages/core/src/api/handlers/plugin-settings.ts),
shows `handlePluginSettingsUpdate` validating, encrypting, transactionally
writing, and reading back declared keys; it takes no plugin callback and
dispatches no settings lifecycle event. Settings are namespaced as
`plugin:{pluginId}:settings:{key}` in
[`packages/core/src/plugins/settings.ts`](https://github.com/emdash-cms/emdash/blob/54209bc9bd0b48e12bdefa8ac971da01ced7990f/packages/core/src/plugins/settings.ts).
Connection establishment therefore belongs in the authenticated plugin admin
page flow, rather than relying on undocumented host internals.

GitHub's current [repository rename documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
confirms that ordinary web URLs and `git clone`, `git fetch`, and `git push`
requests to the old repository location redirect after a rename. Project Pages
URLs are the exception; GitHub Actions hosted from a renamed repository also do
not redirect. The documented conditions include having organization-owner or
repository-admin permission and not recreating a repository under the old name.
Thus a normal rename from `BlackSwampAI/emdash-openanalytics` to
`BlackSwampAI/emdash-plugin-openanalytics` preserves ordinary repository and
git traffic, subject to those stated exceptions.

Inspected on 2026-09-29 before implementation:

- EmDash [`54209bc9bd0b48e12bdefa8ac971da01ced7990f`](https://github.com/emdash-cms/emdash/tree/54209bc9bd0b48e12bdefa8ac971da01ced7990f),
  core package version 1.0.1. Tests and build use the published `emdash@1.0.1`.
- OpenAnalytics [`f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9`](https://github.com/OpenLabs-so/openanalytics/tree/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9).

Rechecked for the native admin PR using current official docs, installed package
source, and `git ls-remote HEAD` for both upstream repositories. These remain
the current upstream HEAD revisions. Search engine commit listings can be stale;
the contracts below follow the source at those revisions.

## EmDash

The [native-plugin tutorial](https://docs.emdashcms.com/plugins/creating-native-plugins/your-first-native-plugin/)
defines a build-time `PluginDescriptor` and a named runtime `createPlugin` export
returning `definePlugin(...)`. This package provides `openAnalytics()` as the
descriptor factory, registered in `emdash({ plugins: [...] })`. The plugin ID is
unscoped because it occupies one API URL segment; the npm package remains scoped.

[Generated settings](https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/)
use `admin.settingsSchema` and `ctx.settings.get`. Defaults appear in the form
but are not persisted automatically, so runtime reads apply the same defaults.
`secret` values are encrypted using `EMDASH_ENCRYPTION_KEY`; admin responses only
indicate whether the secret is set. The source implementation is
`packages/core/src/plugins/settings.ts` and the settings API handler is
`packages/core/src/api/handlers/plugin-settings.ts`.

[Page fragments](https://docs.emdashcms.com/plugins/creating-native-plugins/page-fragments/)
require `hooks.page-fragments:register`. Sandboxed plugins are excluded from this
hook. Native `external-script` contributions support `placement`, `src`, `async`,
`attributes`, and `key`; the renderer escapes attributes and deduplicates keys
within each placement. The public theme must render `EmDashHead` with a public
page context. Sources: `plugins/hooks.ts`, `page/fragments.ts`, and the
`EmDashHead.astro` component in `packages/core/src`.

Native plugin routes receive one context combining request data and plugin APIs.
Private routes support existing permissions and method restrictions. EmDash owns
authentication, CSRF checks, and response envelopes. This plugin uses a private
POST route with `plugins:manage`.

[Block Kit](https://docs.emdashcms.com/plugins/creating-plugins/block-kit/)
supports native plugins with `admin.pages`, a private POST `admin` route, and
JSON `BlockResponse` results. No admin entry module or browser plugin code is
needed. The host posts `page_load` with `page`, or `block_action` with `action_id`,
`value`, and `page`; replacement blocks update the interface. This plugin checks
the declared page and allowed actions/ranges before any upstream request.

The published `@emdash-cms/blocks@1.0.1` types define headers, fields, actions,
selects/buttons, stats, banners, context, and a native timeseries chart with
`config.chart_type: "timeseries"` and `[timestamp_ms, value]` points. The host
owns chart rendering, typography, spacing, navigation, and initial loading.
Forms, tables (including badge cells), and tabs are available; this page now
uses native tables for Top Pages and Traffic Sources. There is no standalone
status badge or plugin-owned loading block; banners/fields represent connection
state.

Only Block Kit **types** are imported in production; the blocks package is a
development dependency and its React/chart renderer is not bundled. Tests use
the upstream block validator because trusted native responses do not receive
the sandboxed response validation policy automatically.

Installed runtime source `EmDashRuntime.resolveTrustedUiContext` supplies native
admin locale/direction for declared pages. Neither `ctx.ui` nor `ctx.site`
includes a timezone. Plugin settings are scoped to the plugin; the host
`site:timezone` is not exposed through them. The overview therefore provides a
small IANA timezone setting, defaults to UTC, and displays the timezone. It does
not query internal host tables or infer timezone from content locale.

Upstream tests use Vitest. The published
`emdash/internal/plugin-test-runtime` exposes the runtime, route dispatcher, and
settings handlers for integration tests; `emdash/page` exposes fragment rendering.
These internal test exports are development-only and do not enter this package's
production code.

## OpenAnalytics

The [CMS/WordPress contract](https://github.com/OpenLabs-so/openanalytics/blob/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9/docs/wordpress/README.md)
specifies Bearer authentication with a site-bound private read key and the exact
tracker attributes `data-key` and `data-collector`.
`GET /v1/read/site` requires `site:read`. Analytics reads require
`analytics:read`, which older/default keys do not necessarily carry.

Verified implementation: `apps/api/src/http/read-key.ts`; schema:
`packages/contracts/openapi/openapi.yaml` (`SiteReadContext` and
`SiteInstallContext`). The response includes `site_id`, `slug`, `name`, `status`,
and `install`. Each installation field is required but nullable. Unknown added
fields must be ignored. Statuses currently are `active`, `suspended`, `deleting`,
and `deleted`. No domain field is provided by this endpoint.

The official API default is `https://api.getopen.so`. Script and collector URLs
come from the deployment's `COLLECTOR_BASE_URL`; they are not derived from the
API host. The read-key budget is 60 requests/minute with a burst of 120, which
motivates saving validated installation data instead of reading on every page.

The WordPress guide's 402 billing description predates the current site status
model. The current metadata route deliberately permits suspended sites so
integrations can obtain installation details and show status. Analytics reads
have a separate suspended-site gate. The client still normalizes HTTP 402 for
compatibility, along with 401, 403, 404, 429, and service errors.

### Overview and timeseries

Verified against the pinned [OpenAPI schemas](https://github.com/OpenLabs-so/openanalytics/blob/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9/packages/contracts/openapi/openapi.yaml)
and [read-key route implementation](https://github.com/OpenLabs-so/openanalytics/blob/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9/apps/api/src/http/read-key.ts):

- `GET /v1/read/analytics/overview`: `meta`, aggregate `totals` containing
  `visitors`, `pageviews`, `events`, and `billable_events`, and nullable
  `comparison`. No sessions, duration, or bounce metric is supplied here.
- `GET /v1/read/analytics/timeseries`: `meta`, `series` of UTC `bucket` instants
  with `visitors`, `pageviews`, and `events`, and nullable `comparison`.
- Both require explicit full UTC `from`/`to` instants for a half-open range and
  an IANA `timezone`. This plugin explicitly sends `hour` for overview totals
  across all four presets, and `hour` for the 24h chart or `day` for 7d/30d/90d.
  Timeseries additionally supports `minute`/`week`; overview supports
  `hour`/`day`. Automatic grain selection can
  produce around 1,440 minute buckets for 24h, so it is deliberately avoided.
- The [aggregate resolver](https://github.com/OpenLabs-so/openanalytics/blob/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9/apps/api/src/analytics/resolve.ts)
  refuses forced overview `day` for non-UTC timezone offsets. Overview `hour`
  reads the quarter-hour atom rollup and supports the full 90d preset (the
  current default cap is 400d). Timeseries `day` can compose local days from
  that rollup. These endpoints therefore intentionally use separate resolutions.
  Effective bounds snap down to rollup boundaries: a UTC daily chart may end at
  the last UTC midnight while hourly totals include more recent quarter-hours.
  The UI exposes effective queried ranges instead of hiding that difference.
- Aggregate visitors come from overview, never from summing/rebucketing chart
  points. Visitor identities rotate at UTC midnight; a visitor can count in
  several buckets. Overview requests `compare=true` and displays the server's
  preceding-period totals below each metric, with its `comparison_range`.
  Timeseries does not request comparison. No client-calculated percentage,
  summed bucket total, or separate comparison HTTP request is introduced.
- `meta.freshness` contains `state` (`ok`, `no_data`, `stale`, `degraded`), nullable
  `watermark`, and `as_of`. The watermark is the site's latest rolled-up bucket,
  potentially outside the requested range; it is not a guarantee that every
  event through that instant has arrived. The UI labels it accordingly and
  handles absent freshness metadata conservatively.
- `meta.accuracy` distinguishes `exact`, `estimated`, and `provider_defined`;
  imported data can affect visitor totals. `partial` and `truncated` also affect
  interpretation. These metadata flags receive concise UI notices.
- HTTP 403 `FORBIDDEN` means missing scope; HTTP 403 `SITE_SUSPENDED` means the
  site's analytics service is suspended. Only the fixed error code is inspected
  to distinguish these states, never the upstream error message. HTTP 402 is
  kept as a legacy billing mapping. HTTP 429 carries a `Retry-After` delay;
  HTTP 503 denotes service unavailability. Invalid ranges or unsupported grain
  can return HTTP 400.

The CMS guide recommends reads on actual admin use and warns against sharing a
read-key response cache across administrators. Each analytics page interaction
reads overview, timeseries, pages, and sources; validation adds one site read.
No polling or automatic retries are introduced.

The native timeseries chart has no timezone formatting option. OpenAnalytics
aligns the returned buckets to the configured timezone, and the page formats
range/freshness text in that timezone, but native chart tick/tooltips use the
administrator's browser timezone. The UI discloses this and uses a neutral axis
label; timestamps are never shifted to fake timezone formatting.

## Top pages and traffic sources

Verified again against OpenAnalytics `main` at
[`f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9`](https://github.com/OpenLabs-so/openanalytics/tree/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9)
on 2026-09-29; `git ls-remote origin refs/heads/main` matched this SHA.

The plugin uses these private read-key operations:

```http
GET /v1/read/analytics/pages?from=...&to=...&timezone=...&limit=10&sort=views
GET /v1/read/analytics/sources?from=...&to=...&timezone=...&limit=10
```

Both require `from`, `to`, and `timezone`. The instants are ISO-8601 UTC and
form a half-open interval: `from` is included and `to` is excluded. `timezone`
is an IANA timezone used to interpret calendar boundaries. `limit` is optional
and accepts integers 1 through 500 (default 100); this plugin requests 10 rows.
Pages also accepts `sort` (`views`, `entrances`, or `exits`, default `views`)
and both endpoints accept optional session-scoped `filters`. The site selector
header is not sent with a private site-bound key; it is for OAuth credentials.

Pages returns `{ meta, items }`. A row requires `page_path`, `views`,
`visitors`, `entrances`, `exits`, `bounces`, and `bounce_rate`. Counts are
nonnegative integers. Session measures may be null: null means the metric was
not measured, the session-decoration read did not cover that path, or the row
is imported; zero means the server measured zero. `entrances` counts sessions
that began on a path, `exits` sessions ending there, and `bounces` unengaged
sessions counted on their entry path. `bounce_rate` is `bounces / entrances`
and is null when no denominator was measured. Pages are ranked and cut by the
server according to `sort`; re-sorting a views-limited response in the client
would misrepresent the top-N result.

Sources returns `{ meta, items }`. A row requires the string tuple
`referrer_domain`, `utm_source`, `utm_medium`, and `utm_campaign`, plus
nonnegative integer `views` and `visitors`. The canonical external referrer is
a lowercase host without `www`, port, or path. Empty `referrer_domain` means
Direct and also includes internal navigation; historical stored spellings were
not rewritten. UTM fields may be empty. Rows represent attribution tuples, not
sessions, and the report is ranked/cut by views.

Both responses require metadata describing requested and effective ranges,
timezone, resolution, data sources, accuracy, freshness, comparison range,
truncation, cache state, and partial state. For these reports
`comparison_range` is null. Freshness state distinguishes `no_data`, `ok`,
`stale`, and `degraded`. Reports can merge live events with imported provider
data; metadata identifies sources and whether results are exact,
provider-defined, or estimated. A legitimate empty result is an empty `items`
array, not an error.

The documented HTTP responses are 400 for invalid/unservable ranges, 401 for
missing/invalid authentication, 403 for missing analytics scope or suspended
site, 404 for unknown site, 429 for rate limiting, and 503 when analytics
storage is unavailable. Error envelopes carry stable codes, including
`FORBIDDEN`, `SITE_SUSPENDED`, `RANGE_TOO_LARGE`, and
`SERVICE_UNAVAILABLE`; clients should not display response messages as trusted
content. A suspended site closes analytics reads with `SITE_SUSPENDED`;
tracker installation state is a separate concern. Hosted deployments may
have a limited billing-grace period for ingest, governed by the collector's
admission policy.

Primary source locations in that pinned revision:

- `packages/contracts/openapi/openapi.yaml:1529-1594` — paths, auth and HTTP responses.
- `packages/contracts/openapi/openapi.yaml:8468-8505` — analytics metadata and freshness.
- `packages/contracts/openapi/openapi.yaml:8777-8889` — pages and sources row schemas.
- `packages/contracts/openapi/openapi.yaml:12030-12079,12152-12161,12218-12237` — site selector, range/timezone, limit and pages sort.
- `apps/api/src/http/read-key.ts:896-920` — private-key pages read and session decoration.
- `apps/api/src/analytics/service.ts:1036-1072,1168-1180` — pages session decoration/ranking and sources view ranking.
- `apps/api/src/http/middleware.ts:183-197` and `apps/api/src/http/read-key.ts:600-608` — suspended-site analytics gate.
- `apps/tracker/src/core.ts:81-90` and `apps/collector/src/ingest-config-store.ts:215-270` — tracker stand-down and collector admission during suspension.
