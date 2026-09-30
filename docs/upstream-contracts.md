# Verified upstream contracts

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
Forms, tables (including badge cells), and tabs are available but unnecessary
for this page. There is no standalone status badge or plugin-owned loading
block; banners/fields represent connection state.

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
read-key response cache across administrators. Each overview interaction makes
only two analytics reads; validation explicitly adds one site read. No polling,
automatic retries, or extra read endpoints are introduced.

The native timeseries chart has no timezone formatting option. OpenAnalytics
aligns the returned buckets to the configured timezone, and the page formats
range/freshness text in that timezone, but native chart tick/tooltips use the
administrator's browser timezone. The UI discloses this and uses a neutral axis
label; timestamps are never shifted to fake timezone formatting.
