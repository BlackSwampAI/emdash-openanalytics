# @blackswampai/emdash-openanalytics

Native EmDash CMS integration for OpenAnalytics, by Black Swamp AI.

This initial scaffold provides configuration and connection validation, encrypted
server-side credential storage through EmDash, and public-site tracker installation.
Embedded analytics UI is planned and is outside this release.

## Installation

Requires EmDash 1.0.1 or later in the 1.x series and Node.js 22.16 or later.
This scaffold has not been published to npm. For local testing, run `pnpm install`
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
   Request `site:read` and `analytics:read`. This scaffold uses only `site:read`;
   `analytics:read` prepares the key for the future embedded analytics UI.
   Older keys may only have `site:read`; site validation cannot verify the extra scope.
2. Configure `EMDASH_ENCRYPTION_KEY` on the EmDash server **before saving a key**.
   Follow [EmDash's secrets and key management guide](https://docs.emdashcms.com/deployment/secrets/).
3. Open **Plugins**, then the settings control for this plugin. Save the API URL,
   private read key, and tracking switch. Tracking defaults to enabled, but no
   tracker appears before a successful connection validation.
4. Validate the saved connection with the authenticated server route below.

The initial scaffold exposes a server route instead of a setup wizard. From the
browser console on your EmDash admin page, while signed in as an administrator:

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

Validation saves the returned public installation configuration. Public page
requests use this saved configuration without calling the OpenAnalytics read API.
Changing the API URL or private key stops injection until you validate again.
A failed validation clears the saved connection. Turning tracking off suppresses
injection immediately; turning it on uses the existing valid connection.

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

- No analytics dashboard, custom admin page, automatic refresh, polling, or retries.
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
server-side OpenAnalytics client, saved connection state, and tracker fragments.
See [verified upstream contracts](docs/upstream-contracts.md) for versions and
the native-plugin/security decisions. MIT licensed; no OpenAnalytics source is bundled.
