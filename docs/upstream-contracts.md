# Verified upstream contracts

Inspected on 2026-09-29 before implementation:

- EmDash [`54209bc9bd0b48e12bdefa8ac971da01ced7990f`](https://github.com/emdash-cms/emdash/tree/54209bc9bd0b48e12bdefa8ac971da01ced7990f),
  core package version 1.0.1. Tests and build use the published `emdash@1.0.1`.
- OpenAnalytics [`f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9`](https://github.com/OpenLabs-so/openanalytics/tree/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9).

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
is supported by native plugins through an admin interaction route, declared page
or widget metadata, and JSON block responses. Native React pages/widgets require
separate descriptor/runtime entries and an admin module. Neither is needed for
this scaffold; Block Kit remains a suitable candidate for PR #2.

Upstream tests use Vitest. The published
`emdash/internal/plugin-test-runtime` exposes the runtime, route dispatcher, and
settings handlers for integration tests; `emdash/page` exposes fragment rendering.
These internal test exports are development-only and do not enter this package's
production code.

## OpenAnalytics

The [CMS/WordPress contract](https://github.com/OpenLabs-so/openanalytics/blob/f7fc9169f32d48e55eb9106bceae9e87b6aa6bb9/docs/wordpress/README.md)
specifies Bearer authentication with a site-bound private read key and the exact
tracker attributes `data-key` and `data-collector`.
`GET /v1/read/site` requires `site:read`. Future analytics reads require
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
