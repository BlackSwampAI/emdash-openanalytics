# EmDash OpenAnalytics screenshot demo

Run `pnpm screenshot` from the repository root. It builds `dist/`, starts a local
OpenAnalytics fixture and an actual EmDash Astro admin using the packaged plugin
descriptor, authenticates through EmDash's development-only bypass, and opens
the plugin's blank analytics page. The harness fills and saves EmDash's native
settings form with the fixture API URL, synthetic private key, tracking switch,
and timezone. Saving makes no OpenAnalytics request. It then opens the analytics
page again, where the first site validation happens automatically, and captures overview, reports, and
narrow-layout screenshots under `docs/screenshots/`.

The demo asserts that the blank-settings page has no connection controls, the
first configured page visit makes exactly one site read before the four analytics
reads, and revisiting the page with unchanged settings makes no second site read.
There is no manual validation step in the setup.

The fixture and EmDash app bind to `127.0.0.1` on reserved ephemeral ports. Their readiness routes require a per-run random token, and EmDash also refuses to start if its configured port is occupied. The fixture accepts only its synthetic `oa_sk_demo_fixture_only_…` key. The EmDash demo database lives in a newly created temporary directory and is removed on exit. Captures are staged in another temporary directory; before they are copied into the repository, the harness scans rendered DOM text, page HTML, text/JSON browser responses, process output, and PNG bytes for private-key-shaped values and the fixture key. This environment has no OCR tool, so the screenshot check supplements the scan of the exact DOM used to take each image.

The fixture keeps totals, comparison values, report rows, and chart shape fixed. It echoes the selected request range and timezone in response metadata and verifies overview, timeseries, pages, and sources all receive one matching interval. Request bounds and connection-validation time follow the current system clock; no production code is patched to freeze time. The chart generates points within the selected window. This gives stable content and layout while preserving the real admin range behavior.

EmDash's `/_emdash/api/setup/dev-bypass` is used only on the loopback-bound Astro development server. EmDash guards this route behind `import.meta.env.DEV`. No dev bypass is exposed by the screenshot harness on a non-loopback address.
