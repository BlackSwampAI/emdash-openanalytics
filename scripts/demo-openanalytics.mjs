import { createServer } from "node:http";

const PORT = Number(process.env.OA_FIXTURE_PORT ?? 4389);
const RUN_ID = process.env.OA_FIXTURE_RUN_ID ?? "demo-only";
const SYNTHETIC_KEY = "oa_sk_demo_fixture_only_00000000000000000000000000000000";
const STABLE_NOW = "2026-09-29T15:45:00.000Z";
const SERIES_VALUES = [58, 72, 64, 91, 106, 88, 112, 94, 126, 119, 101, 138, 147, 168];
const observedReads = [];

function send(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function requestInfo(req, report = false) {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
	const from = url.searchParams.get("from") ?? "2026-08-30T16:00:00.000Z";
	const to = url.searchParams.get("to") ?? "2026-09-29T16:00:00.000Z";
	const span = Date.parse(to) - Date.parse(from);
	const prior = { from: new Date(Date.parse(from) - span).toISOString(), to: from };
	const timezone = url.searchParams.get("timezone") ?? "America/New_York";
	const isComparison = !report && url.searchParams.get("compare") === "true";
	return {
		from,
		to,
		limit: Number(url.searchParams.get("limit") ?? 10),
		meta: {
			requested_range: { from, to },
			effective_range: { from, to },
			timezone,
			resolution: url.searchParams.get("resolution") ?? (report ? "day" : "hour"),
			data_sources: ["live"],
			accuracy: "exact",
			freshness: { state: "ok", watermark: STABLE_NOW, as_of: STABLE_NOW },
			comparison_range: isComparison ? prior : null,
			truncated: false,
			cached: false,
			partial: false,
		},
	};
}

const server = createServer((req, res) => {
	if (new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).pathname === "/__health") {
		const supplied = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).searchParams.get("run");
		return supplied === RUN_ID
			? send(res, 200, { ok: true, run: RUN_ID })
			: send(res, 404, { error: { code: "NOT_FOUND" } });
	}
	if (req.url === "/__requests") return send(res, 200, observedReads);
	if (req.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`)
		return send(res, 401, { error: { code: "UNAUTHORIZED", message: "fixture auth required" } });
	if (req.method !== "GET") return send(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
	const path = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;
	if (path.startsWith("/v1/read/analytics/")) {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
		observedReads.push({
			path,
			from: url.searchParams.get("from"),
			to: url.searchParams.get("to"),
			timezone: url.searchParams.get("timezone"),
			limit: url.searchParams.get("limit"),
		});
	}
	if (path === "/v1/read/site") {
		return send(res, 200, {
			site_id: "site_demo_openanalytics",
			slug: "emdash-demo",
			name: "EmDash Demo",
			status: "active",
			install: {
				tracking_key: "oa_pk_demo_tracking_00000000000000000000000000000000",
				script_url: `http://127.0.0.1:${PORT}/tracker.js`,
				collector_url: `http://127.0.0.1:${PORT}/v1/collect`,
			},
		});
	}
	if (path === "/v1/read/analytics/overview") {
		const request = requestInfo(req);
		return send(res, 200, {
			totals: { visitors: 1284, pageviews: 2911, events: 4201, billable_events: 4201 },
			comparison: request.meta.comparison_range
				? { totals: { visitors: 1102, pageviews: 2458, events: 3660, billable_events: 3660 } }
				: null,
			meta: request.meta,
		});
	}
	if (path === "/v1/read/analytics/timeseries") {
		const request = requestInfo(req);
		const from = Date.parse(request.from);
		const span = Date.parse(request.to) - from;
		const series = SERIES_VALUES.map((visitors, i) => {
			const bucket = new Date(from + span * ((i + 0.5) / SERIES_VALUES.length));
			return {
				bucket: bucket.toISOString(),
				visitors,
				pageviews: visitors * 2 + (i % 3) * 5,
				events: visitors * 3 + (i % 4) * 7,
			};
		});
		return send(res, 200, { series, meta: request.meta, comparison: null });
	}
	if (path === "/v1/read/analytics/pages") {
		const request = requestInfo(req, true);
		return send(res, 200, {
			items: [
				{
					page_path: "/",
					views: 1482,
					visitors: 904,
					entrances: 514,
					exits: 302,
					bounces: 201,
					bounce_rate: 0.392,
				},
				{
					page_path: "/blog/openanalytics",
					views: 712,
					visitors: 518,
					entrances: 210,
					exits: 177,
					bounces: 86,
					bounce_rate: 0.41,
				},
				{
					page_path: "/workflows/content-operations",
					views: 431,
					visitors: 302,
					entrances: 108,
					exits: 95,
					bounces: 39,
					bounce_rate: 0.36,
				},
				{
					page_path: "/contact",
					views: 219,
					visitors: 184,
					entrances: 97,
					exits: 81,
					bounces: 44,
					bounce_rate: 0.45,
				},
			].slice(0, request.limit),
			meta: request.meta,
		});
	}
	if (path === "/v1/read/analytics/sources") {
		const request = requestInfo(req, true);
		return send(res, 200, {
			items: [
				{
					referrer_domain: "",
					utm_source: "newsletter",
					utm_medium: "email",
					utm_campaign: "autumn_launch",
					views: 511,
					visitors: 482,
				},
				{
					referrer_domain: "",
					utm_source: "",
					utm_medium: "",
					utm_campaign: "",
					views: 393,
					visitors: 361,
				},
				{
					referrer_domain: "google.com",
					utm_source: "",
					utm_medium: "",
					utm_campaign: "",
					views: 327,
					visitors: 299,
				},
				{
					referrer_domain: "reddit.com",
					utm_source: "",
					utm_medium: "",
					utm_campaign: "",
					views: 205,
					visitors: 177,
				},
				{
					referrer_domain: "linkedin.com",
					utm_source: "",
					utm_medium: "social",
					utm_campaign: "openanalytics_guide",
					views: 144,
					visitors: 126,
				},
				{
					referrer_domain: "github.com",
					utm_source: "",
					utm_medium: "",
					utm_campaign: "",
					views: 92,
					visitors: 84,
				},
			].slice(0, request.limit),
			meta: request.meta,
		});
	}
	return send(res, 404, { error: { code: "NOT_FOUND" } });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[oa-fixture] listening on 127.0.0.1:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => server.close(() => process.exit(0)));
