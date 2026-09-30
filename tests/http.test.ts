import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getOverview, getSite, getTimeseries } from "../src/openanalytics/client";
import { OpenAnalyticsError } from "../src/openanalytics/errors";
import { parseConfiguration } from "../src/settings/config";

const readKey = "oa_sk_http_fixture_secret";
const site = {
	site_id: "01J0SITE000000000000000000",
	slug: "self-hosted",
	name: "Self-hosted site",
	status: "active",
	install: {
		tracking_key: "oa_pk_fixture",
		script_url: "https://assets.example.test/custom-tracker.js",
		collector_url: "https://events.example.test/collect",
	},
};
const analyticsQuery = {
	from: "2026-07-16T00:00:00.000Z",
	to: "2026-07-23T00:00:00.000Z",
	timezone: "America/New_York",
	resolution: "hour" as const,
};

let server: Server;
let baseUrl: string;
let requestPath = "";
let authorization = "";
let redirectedRequestCount = 0;
let slowResponse = false;
let redirectToFixture = false;

function sendJson(response: ServerResponse, value: unknown) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

async function route(request: IncomingMessage, response: ServerResponse) {
	requestPath = request.url ?? "";
	authorization = request.headers.authorization ?? "";

	if (request.url === "/redirect-target") {
		redirectedRequestCount += 1;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(site));
		return;
	}

	const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
	if (
		![
			"/api-root/v1/read/site",
			"/api-root/v1/read/analytics/overview",
			"/api-root/v1/read/analytics/timeseries",
		].includes(path)
	) {
		response.writeHead(404);
		response.end();
		return;
	}

	if (slowResponse) {
		response.writeHead(200, { "content-type": "application/json" });
		response.flushHeaders();
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (!response.destroyed) response.end(JSON.stringify(site));
		return;
	}

	if (redirectToFixture) {
		response.writeHead(302, { location: "/redirect-target" });
		response.end();
		return;
	}

	if (path === "/api-root/v1/read/site") {
		sendJson(response, site);
		return;
	}
	const url = new URL(request.url ?? "/", "http://fixture.test");
	const meta = {
		requested_range: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
		effective_range: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
		timezone: url.searchParams.get("timezone"),
		resolution: url.searchParams.get("resolution"),
		data_sources: ["live"],
		accuracy: "exact",
		freshness: { state: "ok", watermark: analyticsQuery.to, as_of: analyticsQuery.to },
		comparison_range: null,
		truncated: false,
		cached: false,
		partial: false,
	};
	const body = path.endsWith("/overview")
		? {
				meta,
				totals: { events: 1200, pageviews: 980, visitors: 380, billable_events: 1150 },
				comparison: null,
			}
		: {
				meta,
				series: [{ bucket: analyticsQuery.from, events: 50, pageviews: 40, visitors: 20 }],
				comparison: null,
			};
	sendJson(response, body);
}

beforeAll(async () => {
	server = createServer((request, response) => {
		void route(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP fixture failed to bind");
	baseUrl = `http://127.0.0.1:${address.port}/api-root`;
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

describe("OpenAnalytics HTTP transport", () => {
	it("requests the site below an API path prefix and preserves custom install URLs", async () => {
		slowResponse = false;
		const result = await getSite(parseConfiguration({ apiUrl: baseUrl, readKey }));
		expect(requestPath).toBe("/api-root/v1/read/site");
		expect(authorization).toBe(`Bearer ${readKey}`);
		expect(result).toEqual(site);
	});

	it("rejects a redirect without forwarding the read key", async () => {
		redirectedRequestCount = 0;
		redirectToFixture = true;
		try {
			await expect(getSite(parseConfiguration({ apiUrl: baseUrl, readKey }))).rejects.toMatchObject(
				{ kind: "network" },
			);
			expect(redirectedRequestCount).toBe(0);
		} finally {
			redirectToFixture = false;
		}
	});

	it("times out while waiting for the real HTTP response body", async () => {
		slowResponse = true;
		try {
			try {
				await getSite(parseConfiguration({ apiUrl: baseUrl, readKey, timeoutMs: 20 }));
				throw new Error("expected request to time out");
			} catch (error) {
				expect(error).toBeInstanceOf(OpenAnalyticsError);
				expect(error).toMatchObject({ kind: "timeout" });
			}
		} finally {
			slowResponse = false;
		}
	});

	it("requests analytics reads below an API path prefix with explicit query params", async () => {
		slowResponse = false;
		const result = await getOverview(
			parseConfiguration({ apiUrl: baseUrl, readKey }),
			analyticsQuery,
		);
		const requestUrl = new URL(requestPath, "http://fixture.test");
		expect(requestUrl.pathname).toBe("/api-root/v1/read/analytics/overview");
		expect(requestUrl.searchParams.get("from")).toBe(analyticsQuery.from);
		expect(requestUrl.searchParams.get("to")).toBe(analyticsQuery.to);
		expect(requestUrl.searchParams.get("timezone")).toBe(analyticsQuery.timezone);
		expect(requestUrl.searchParams.get("resolution")).toBe("hour");
		expect(authorization).toBe(`Bearer ${readKey}`);
		expect(result.totals.visitors).toBe(380);
	});

	it("rejects analytics redirects without forwarding the read key", async () => {
		redirectedRequestCount = 0;
		redirectToFixture = true;
		try {
			await expect(
				getTimeseries(parseConfiguration({ apiUrl: baseUrl, readKey }), analyticsQuery),
			).rejects.toMatchObject({ kind: "network" });
			expect(redirectedRequestCount).toBe(0);
		} finally {
			redirectToFixture = false;
		}
	});

	it("times out while an analytics response body is pending", async () => {
		slowResponse = true;
		try {
			await expect(
				getOverview(
					parseConfiguration({ apiUrl: baseUrl, readKey, timeoutMs: 20 }),
					analyticsQuery,
				),
			).rejects.toMatchObject({ kind: "timeout" });
		} finally {
			slowResponse = false;
		}
	});
});
