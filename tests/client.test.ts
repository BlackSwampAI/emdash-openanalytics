import { afterEach, describe, expect, it, vi } from "vitest";

import { getSite } from "../src/openanalytics/client";
import { OpenAnalyticsError, type OpenAnalyticsErrorKind } from "../src/openanalytics/errors";
import { DEFAULT_API_TIMEOUT_MS, parseConfiguration } from "../src/settings/config";

const apiUrl = "http://127.0.0.1:8787";
const readKey = "oa_sk_private_test_secret";
const goodSite = {
	site_id: "01J0SITE000000000000000000",
	slug: "shop",
	name: "Shop",
	status: "active",
	install: {
		tracking_key: "oa_pk_public",
		script_url: "https://c.getopen.so/oa.js",
		collector_url: "https://c.getopen.so",
	},
};

function config(timeoutMs = DEFAULT_API_TIMEOUT_MS) {
	return parseConfiguration({ apiUrl, readKey, timeoutMs });
}

function mockFetch(status: number, body: unknown, headers: HeadersInit = {}) {
	const response = new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
	const fetchMock = vi.fn(async () => response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function expectKind(
	promise: Promise<unknown>,
	kind: OpenAnalyticsErrorKind,
	expectedStatus?: number,
) {
	try {
		await promise;
		throw new Error("expected getSite to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(OpenAnalyticsError);
		expect((error as OpenAnalyticsError).kind).toBe(kind);
		if (expectedStatus !== undefined)
			expect((error as OpenAnalyticsError).status).toBe(expectedStatus);
		expect((error as Error).message).not.toContain(readKey);
		expect((error as Error).message).not.toContain(apiUrl);
		expect((error as Error).stack).not.toContain(readKey);
	}
}

afterEach(() => vi.unstubAllGlobals());

describe("getSite", () => {
	it("reads and projects the site context, ignoring unknown additive fields", async () => {
		const fetchMock = mockFetch(200, {
			...goodSite,
			future_metadata: { token: readKey },
			extra: "ignored",
		});
		expect(await getSite(config())).toEqual(goodSite);
		expect(fetchMock).toHaveBeenCalledWith(
			`${apiUrl}/v1/read/site`,
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				cache: "no-store",
				headers: {
					Authorization: `Bearer ${readKey}`,
					Accept: "application/json",
				},
			}),
		);
	});

	it("allows required nullable install members", async () => {
		mockFetch(200, {
			...goodSite,
			install: { tracking_key: null, script_url: null, collector_url: null },
		});
		expect((await getSite(config())).install).toEqual({
			tracking_key: null,
			script_url: null,
			collector_url: null,
		});
	});

	it.each([
		[401, "unauthorized"],
		[403, "forbidden"],
		[402, "billing"],
		[404, "not_found"],
		[429, "rate_limited"],
		[500, "server"],
		[503, "server"],
	] as const)("maps HTTP %i to a fixed %s error", async (httpStatus, kind) => {
		mockFetch(httpStatus, { message: readKey });
		await expectKind(getSite(config()), kind, httpStatus);
	});

	it("exposes a numeric Retry-After value for 429", async () => {
		mockFetch(429, {}, { "retry-after": "17" });
		try {
			await getSite(config());
			throw new Error("expected getSite to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(OpenAnalyticsError);
			expect((error as OpenAnalyticsError).retryAfterSeconds).toBe(17);
		}
	});

	it("rejects malformed JSON and malformed site contexts with safe errors", async () => {
		mockFetch(200, "<html>oops</html>");
		await expectKind(getSite(config()), "invalid_response");
		mockFetch(200, {
			...goodSite,
			install: {
				tracking_key: "oa_sk_leak",
				script_url: null,
				collector_url: null,
			},
		});
		await expectKind(getSite(config()), "invalid_response");
	});

	it.each([
		{ ...goodSite, install: undefined },
		{ ...goodSite, site_id: null },
		{ ...goodSite, status: "unknown" },
		{ ...goodSite, install: { ...goodSite.install, script_url: 42 } },
		{ ...goodSite, install: { ...goodSite.install, collector_url: undefined } },
	])("rejects incomplete or incorrectly typed site contracts", async (payload) => {
		mockFetch(200, payload);
		await expectKind(getSite(config()), "invalid_response");
	});

	it.each([
		{ ...goodSite, name: readKey },
		{
			...goodSite,
			install: { ...goodSite.install, script_url: `https://tracker.test/${readKey}` },
		},
		{
			...goodSite,
			install: {
				...goodSite.install,
				collector_url: "https://events.test/%6fa%5fsk%5fprivate_test_secret",
			},
		},
	])("rejects private credentials in projected site metadata", async (payload) => {
		mockFetch(200, payload);
		await expectKind(getSite(config()), "invalid_response");
	});

	it("maps aborts to a timeout error", async () => {
		const fetchMock = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expectKind(getSite(config(10)), "timeout");
	});

	it("maps rejected redirects to a safe network error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("redirect URL contains secret");
			}),
		);
		await expectKind(getSite(config()), "network");
	});
});
