import { afterEach, describe, expect, it, vi } from "vitest";

import { getOverview, getTimeseries } from "../src/openanalytics/client";
import { OpenAnalyticsError } from "../src/openanalytics/errors";
import { parseConfiguration } from "../src/settings/config";

const apiUrl = "https://api.openanalytics.test";
const readKey = "oa_sk_analytics_client_fixture_secret";
const config = parseConfiguration({ apiUrl, readKey });
const query = {
	from: "2026-07-16T00:00:00.000Z",
	to: "2026-07-23T00:00:00.000Z",
	timezone: "America/New_York",
	resolution: "hour" as const,
};

const meta = {
	requested_range: { from: query.from, to: query.to },
	effective_range: { from: query.from, to: query.to },
	timezone: query.timezone,
	resolution: query.resolution,
	data_sources: ["live"],
	accuracy: "exact",
	freshness: {
		state: "stale",
		watermark: "2026-07-23T00:00:00.000Z",
		as_of: "2026-07-23T09:00:00.000Z",
	},
	comparison_range: null,
	truncated: false,
	cached: false,
	partial: false,
};

const overview = {
	meta,
	totals: { events: 1200, pageviews: 980, visitors: 380, billable_events: 1150 },
	comparison: null,
};

const timeseries = {
	meta,
	series: [
		{
			bucket: "2026-07-16T00:00:00.000Z",
			events: 1200,
			pageviews: 980,
			visitors: 380,
		},
	],
	comparison: null,
};

function mockFetch(status: number, body: unknown, headers: HeadersInit = {}) {
	const response = new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
	const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAnalytics analytics read client", () => {
	it("reads the typed overview with explicit range, timezone, and resolution", async () => {
		const fetchMock = mockFetch(200, overview);

		expect(await getOverview(config, query)).toEqual(overview);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [input, init] = fetchMock.mock.calls[0] ?? [];
		const url = new URL(String(input));
		expect(url.origin + url.pathname).toBe(
			"https://api.openanalytics.test/v1/read/analytics/overview",
		);
		expect(url.searchParams.get("from")).toBe(query.from);
		expect(url.searchParams.get("to")).toBe(query.to);
		expect(url.searchParams.get("timezone")).toBe(query.timezone);
		expect(url.searchParams.get("resolution")).toBe("hour");
		expect(url.searchParams.has("compare")).toBe(false);
		expect(init).toMatchObject({
			method: "GET",
			redirect: "error",
			cache: "no-store",
			headers: { Authorization: `Bearer ${readKey}`, Accept: "application/json" },
		});
	});

	it("projects only documented fields and ignores additive response fields", async () => {
		mockFetch(200, { ...overview, future: { credential: readKey } });
		const result = await getOverview(config, query);
		expect(JSON.stringify(result)).not.toContain(readKey);
		expect("future" in result).toBe(false);
	});

	it("requests and projects previous-period comparison only when explicitly enabled", async () => {
		const comparison = {
			from: "2026-07-09T00:00:00.000Z",
			to: query.from,
		};
		const compareResponse = {
			...overview,
			meta: { ...meta, comparison_range: comparison },
			comparison: {
				totals: { events: 1100, pageviews: 900, visitors: 350, billable_events: 1000 },
			},
		};
		const fetchMock = mockFetch(200, compareResponse);
		const result = await getOverview(config, { ...query, compare: true });
		expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("compare")).toBe("true");
		expect(result.meta.comparison_range).toEqual(comparison);
		expect(result.comparison?.totals).toEqual(compareResponse.comparison.totals);
	});

	it("reads timeseries at the explicitly requested hour resolution", async () => {
		const fetchMock = mockFetch(200, timeseries);
		const hourly = { ...query, resolution: "hour" as const };

		expect(await getTimeseries(config, hourly)).toEqual(timeseries);
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.pathname).toBe("/v1/read/analytics/timeseries");
		expect(url.searchParams.get("from")).toBe(query.from);
		expect(url.searchParams.get("to")).toBe(query.to);
		expect(url.searchParams.get("timezone")).toBe(query.timezone);
		expect(url.searchParams.get("resolution")).toBe("hour");
		expect(url.searchParams.has("compare")).toBe(false);
	});

	it.each([
		["overview", () => getOverview(config, query), overview, "totals"],
		["timeseries", () => getTimeseries(config, query), timeseries, "series"],
	] as const)(
		"rejects malformed %s responses without returning upstream content",
		async (_name, call, body, required) => {
			const malformed = { ...body, [required]: undefined };
			mockFetch(200, malformed);
			await expect(call()).rejects.toMatchObject({ kind: "invalid_response" });
		},
	);

	it.each([
		{ ...overview, meta: { ...meta, timezone: readKey } },
		{ ...overview, meta: { ...meta, timezone: `America/New_York/${encodeURIComponent(readKey)}` } },
	])("rejects known metadata carrying a raw or encoded private credential", async (body) => {
		mockFetch(200, body);
		await expect(getOverview(config, query)).rejects.toMatchObject({ kind: "invalid_response" });
	});

	it("rejects malformed JSON and invalid freshness metadata", async () => {
		mockFetch(200, "<html>unexpected response</html>");
		await expect(getOverview(config, query)).rejects.toMatchObject({ kind: "invalid_response" });

		mockFetch(200, {
			...overview,
			meta: { ...meta, freshness: { state: "future", as_of: "bad" } },
		});
		await expect(getOverview(config, query)).rejects.toMatchObject({ kind: "invalid_response" });
	});

	it.each([
		{ ...overview, totals: { ...overview.totals, visitors: -1 } },
		{ ...overview, totals: { ...overview.totals, visitors: 1.5 } },
		{ ...overview, totals: { events: 10, pageviews: 8, visitors: 3 } },
	])("rejects invalid counts and incomplete required totals", async (body) => {
		mockFetch(200, body);
		await expect(getOverview(config, query)).rejects.toMatchObject({ kind: "invalid_response" });
	});

	it.each([
		{ ...timeseries, series: [{ ...timeseries.series[0], bucket: "not-a-date" }] },
		{ ...timeseries, series: [{ ...timeseries.series[0], pageviews: -1 }] },
		{ ...timeseries, series: [{ ...timeseries.series[0], visitors: 1.2 }] },
	])("rejects invalid time buckets and series values", async (body) => {
		mockFetch(200, body);
		await expect(getTimeseries(config, query)).rejects.toMatchObject({ kind: "invalid_response" });
	});

	it.each([
		{ ...query, from: query.to },
		{ ...query, from: "2026-02-30T00:00:00.000Z" },
		{ ...query, timezone: "Mars/Olympus_Mons" },
		{ ...query, resolution: "minute" as never },
		{ ...query, resolution: { toString: () => "day" } as never },
	])(
		"rejects invalid range, timezone, or resolution before making a request",
		async (invalidQuery) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			await expect(getOverview(config, invalidQuery)).rejects.toMatchObject({
				kind: "configuration",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([undefined, null])("accepts unavailable freshness metadata (%s)", async (freshness) => {
		const response = { ...overview, meta: { ...meta, freshness } };
		mockFetch(200, response);
		const result = await getOverview(config, query);
		expect(result.meta.freshness ?? null).toBeNull();
	});

	it.each([
		[401, {}, "unauthorized"],
		[403, { error: { code: "FORBIDDEN" } }, "analytics_forbidden"],
		[403, { error: { code: "SITE_SUSPENDED" } }, "suspended"],
		[402, { error: { code: "BILLING_REQUIRED" } }, "billing"],
		[400, { error: { code: "RESOLUTION_NOT_AVAILABLE" } }, "resolution_unavailable"],
		[400, { error: { code: "VALIDATION_FAILED" } }, "range_invalid"],
		[429, {}, "rate_limited"],
		[503, {}, "server"],
	] as const)("normalizes analytics HTTP %i safely", async (status, payload, kind) => {
		mockFetch(status, { ...payload, detail: readKey }, { "retry-after": "19" });
		try {
			await getOverview(config, query);
			throw new Error("expected analytics request to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(OpenAnalyticsError);
			expect(error).toMatchObject({ kind, status });
			expect((error as Error).message).not.toContain(readKey);
			expect((error as Error).stack).not.toContain(readKey);
			if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 19 });
		}
	});

	it.each([
		[403, { error: { code: "FORBIDDEN" } }, "analytics_forbidden"],
		[429, {}, "rate_limited"],
		[503, {}, "server"],
	] as const)("normalizes timeseries HTTP %i safely", async (status, payload, kind) => {
		mockFetch(status, { ...payload, detail: readKey }, { "retry-after": "19" });
		await expect(getTimeseries(config, query)).rejects.toMatchObject({ kind, status });
	});

	it("keeps response comparison null and does not invent or merge comparison data", async () => {
		mockFetch(200, overview);
		const result = await getOverview(config, query);
		expect(result.comparison).toBeNull();
		expect(result.totals.visitors).toBe(380);
	});
});
