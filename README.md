# @blackswampai/emdash-openanalytics

Native EmDash CMS integration for OpenAnalytics, by Black Swamp AI.

Native connection validation, public-site tracker installation, and an analytics
overview inside EmDash. The admin page uses EmDash Block Kit controls, metric
cards, notices, and a timeseries chart. Private credentials stay on the server.

## Installation

Requires EmDash 1.0.1 or later in the 1.x series and Node.js 22.16 or later.
This package has not been published to npm. For local testing, run `pnpm install`
and `pnpm build` in this checkout, then install it from your EmDash site:

```sh
pnpm add /path/to/emdash-openanalytics
```

After an npm release is published, the installation command will be:

```sh
pnpm add @blackswampai/emdash-openanalytics
```

Register the native plugin in `astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { openAnalytics } from "@blackswampai/emdash-openanalytics";

export default defineConfig({
	integrations: [
		emdash({
			// Include your site's existing database, storage, and other configuration.
			plugins: [openAnalytics()],
		}),
	],
});
```

Native plugins install as trusted site dependencies and require a deployment.
This plugin belongs in `plugins`, and needs the native-only `page:fragments` hook.

Your public layout must render `<EmDashHead page={page} />` inside `<head>`, using
a context created with `createPublicPageContext` from `emdash/page`.
Import `EmDashHead` from `emdash/ui`. Layouts without that insertion point cannot
render the tracker. See [EmDash's page fragment guide](https://docs.emdashcms.com/plugins/creating-native-plugins/page-fragments/).

## OpenAnalytics setup

1. Create a **private read key** in OpenAnalytics for the site you want to track.
   Request `site:read` and `analytics:read`. Connection validation uses `site:read`;
   the admin overview uses `analytics:read`.
   Older keys may only have `site:read`; site validation cannot verify the extra scope.
2. Configure `EMDASH_ENCRYPTION_KEY` on the EmDash server **before saving a key**.
   Follow [EmDash's secrets and key management guide](https://docs.emdashcms.com/deployment/secrets/).
3. Open **Plugins**, then the settings control for this plugin. Save the API URL,
   private read key, tracking switch, and analytics timezone. Set the timezone
   to your site's IANA timezone, such as `America/New_York`. It defaults to UTC;
   EmDash's native plugin context does not expose the host site's timezone.
   Tracking defaults to enabled, but no tracker appears before successful validation.
4. Open **OpenAnalytics** in EmDash's plugin navigation and click **Validate connection**.
   The page shows the connected site, tracking readiness, API URL, and last
   validation time. Use **Revalidate connection** after rotating tracker settings.

The existing protected validation route also remains available to administrators:

```js
const response = await fetch("/_emdash/api/plugins/emdash-openanalytics/validate-connection", {
	method: "POST",
	headers: { "X-EmDash-Request": "1" },
});
console.log(await response.json());
```

The route requires `plugins:manage`. It reads the stored credential on the server;
you do not pass the key in this request. EmDash wraps the plugin's result in its
standard API response envelope. Connection failures contain safe error details.
Successful validation reports site identity, status, and tracker readiness.

## Analytics overview

The OpenAnalytics page shows visitors, pageviews, and events from the aggregate
overview response, plus visitors and pageviews over time. Choose **Last 24 hours**,
**Last 7 days**, **Last 30 days** (default), or **Last 90 days**. Requests send
explicit UTC bounds and the configured IANA timezone. Overview totals use hourly
rollups; the chart uses hourly buckets for 24 hours or daily buckets for longer
ranges. Visitor buckets are displayed
as returned, never summed into the aggregate visitor metric.

Metric cards show previous-period totals when supplied by OpenAnalytics. These
are server-provided aggregate comparisons; the plugin does not calculate
percentages or infer comparisons from chart buckets.

OpenAnalytics can snap bounds down to available rollup boundaries; the page
shows the effective queried periods. Chart buckets follow the configured
timezone, while native chart tick labels and tooltips use the browser timezone.

Freshness information shows the latest rolled-up data and pipeline status.
Stale, degraded, imported, or partial results receive notices so temporarily low
numbers are easier to interpret. Missing freshness is shown as unavailable.
Authentication failures, missing analytics scope, suspended service, rate limits,
and unavailable upstream service have safe messages and validation/retry controls.

Opening the page or changing its range makes two server-side reads: overview and
timeseries. Revalidation first reads site metadata and refreshes the installation
snapshot. There is no polling, automatic retry, or shared analytics cache. The
private admin route requires `plugins:manage` and EmDash's CSRF protection.

Validation saves the returned public installation configuration. Public page
requests use this saved configuration without calling the OpenAnalytics read API.
The snapshot is bound to the exact normalized API URL and private key. A
different configuration suppresses tracking; restoring the exact validated
configuration makes its matching snapshot usable again. Removing the private
key or turning tracking off suppresses injection immediately.

Temporary network failures, timeouts, rate limits, and service errors during
revalidation preserve a matching last-known-good snapshot. The admin shows the
error while tracking continues from that snapshot. Rejected credentials and
invalid installation responses invalidate the connection. Successful validation
replaces the saved snapshot. A snapshot never enables tracking for a different
API URL or credential.

## Security

`oa_sk_…` is private and server-only. EmDash's `secret` setting encrypts it at
rest and presents a write-only admin input; the plugin never puts it in public
HTML, validation results, or logs. Keep the EmDash encryption key available and
back it up according to the host's secret management practices.

`oa_pk_…` is the public browser tracking key. It belongs in page HTML. The plugin
uses EmDash's structured external-script fragment, which escapes attributes and
deduplicates the tracker by a stable fragment key.

The API client rejects redirects and uses a five-second timeout. API response
bodies and transport exceptions are not echoed into errors. The administrator
controls the API and tracker origins: configure endpoints you trust. HTTP works
for local self-hosted deployments; use HTTPS for production credentials.

## Self-hosting

The API URL defaults to the officially documented `https://api.getopen.so` and
is editable. A custom base URL may include a deployment path prefix. The plugin
retrieves `tracking_key`, `script_url`, and `collector_url` from `/v1/read/site`;
it has no hard-coded hosted tracker or collector URL.

If any installation field is `null`, the connection can still validate, but no
script is emitted. Configure your OpenAnalytics deployment's `COLLECTOR_BASE_URL`
and a live public tracking key, then validate again. This scaffold does not add
manual tracker URL overrides.

## Current limitations

- The overview is intentionally small: no top pages, sources, sessions, funnels,
  revenue, visitor profiles, editor analytics, or realtime polling.
- Revalidate after tracker rotation or a collector URL change. Saved installation
  metadata has no automatic expiry; private-key revocation is detected on validation.
- Static pages receive the snapshot available when they are rendered. Rebuild
  those pages after changing the connection or tracking switch.
- The tracker independently fetches OpenAnalytics's browser configuration. A
  suspended site may validate successfully; ingestion follows OpenAnalytics policy.
- Duplicate protection covers EmDash fragments in a placement. Remove any tracker
  tag already installed manually in the theme.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

`check` runs typechecking, linting, formatting checks, tests, build, and package
verification. CI runs the same checks. No npm publication is performed.

Source boundaries are the native plugin entry, settings/configuration, the
server-side OpenAnalytics client, saved connection state, tracker fragments,
and native admin page.
See [verified upstream contracts](docs/upstream-contracts.md) for versions and
the native-plugin/security decisions and [implementation footprint](docs/implementation-footprint.md)
for the comparison with the n8n integration. MIT licensed; no OpenAnalytics source is bundled.
