import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createDialect as createSqliteDialect } from "emdash/db/sqlite";
import {
	EmDashRuntime,
	dispatchPluginApiRequest,
	handlePluginSettingsUpdate,
	type RuntimeDependencies,
} from "emdash/internal/plugin-test-runtime";
import { renderFragments } from "emdash/page";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlugin } from "../src/plugin";

const runtimes: Array<{ runtime: EmDashRuntime; directory: string }> = [];
const pluginId = "openanalytics";
const privateKey = "oa_sk_admin_test_private_key";
const encryptionKey = `emdash_enc_v1_${Buffer.alloc(32, 12).toString("base64url")}`;
const apiUrl = "https://api.openanalytics.test";
const site = {
	site_id: "site_admin_test",
	slug: "docs",
	name: "Documentation",
	status: "active",
	install: {
		tracking_key: "oa_pk_admin_public",
		script_url: "https://cdn.openanalytics.test/tracker.js",
		collector_url: "https://api.openanalytics.test/v1/collect",
	},
};
const responseMeta = () => {
	const to = new Date().toISOString();
	const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	return {
		requested_range: { from, to },
		effective_range: { from, to },
		timezone: "America/New_York",
		resolution: "day",
		data_sources: ["live"],
		accuracy: "exact",
		freshness: { state: "ok", watermark: to, as_of: to },
		comparison_range: null,
		truncated: false,
		cached: false,
		partial: false,
	};
};

async function makeRuntime() {
	vi.stubEnv("EMDASH_ENCRYPTION_KEY", encryptionKey);
	const directory = mkdtempSync(join(tmpdir(), "openanalytics-admin-test-"));
	const runtime = await EmDashRuntime.create({
		config: {
			database: {
				entrypoint: `openanalytics-admin-test-${basename(directory)}`,
				config: { url: `file:${join(directory, "test.sqlite")}` },
				type: "sqlite",
			},
		},
		plugins: [createPlugin()],
		createDialect: (config) => createSqliteDialect(config),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	} as RuntimeDependencies);
	runtimes.push({ runtime, directory });
	return runtime;
}

async function setSettings(runtime: EmDashRuntime, values: Record<string, unknown>) {
	const plugin = runtime.configuredPlugins.find(({ id }) => id === pluginId);
	if (!plugin?.admin?.settingsSchema) throw new Error("OpenAnalytics settings were not registered");
	const result = await handlePluginSettingsUpdate(
		runtime.db,
		pluginId,
		plugin.admin.settingsSchema,
		values,
	);
	if (!result.success) throw new Error("Could not save OpenAnalytics test settings");
}

async function dispatchAdmin(
	runtime: EmDashRuntime,
	interaction: Record<string, unknown>,
	options: { role?: number; tokenScopes?: string[]; requestHeaders?: Record<string, string> } = {},
) {
	const response = await dispatchPluginApiRequest({
		runtime,
		pluginId,
		path: "admin",
		request: new Request(`https://cms.test/_emdash/api/plugins/${pluginId}/admin`, {
			method: "POST",
			headers: { "content-type": "application/json", ...options.requestHeaders },
			body: JSON.stringify(interaction),
		}),
		...(options.role === undefined
			? {}
			: {
					user: {
						id: `user-${options.role}`,
						email: "admin@example.test",
						name: "Admin test user",
						role: options.role,
						createdAt: new Date().toISOString(),
					},
				}),
		...(options.tokenScopes === undefined ? {} : { tokenScopes: options.tokenScopes }),
	});
	const payload = (await response.json()) as { success?: boolean; data?: unknown };
	return {
		response,
		payload,
		data: payload.data as { blocks?: Array<Record<string, unknown>>; [key: string]: unknown },
	};
}

type SiteFailure = "network" | "timeout" | 401 | 429 | 500 | 503;

function installFetch(
	options: {
		site?: unknown;
		analyticsStatus?: number;
		analyticsErrorCode?: string;
		analyticsFailurePath?: string;
		siteStatus?: number;
		missingFreshness?: boolean;
		freshnessState?: string;
		emptyReports?: boolean;
		sourceRows?: Array<{
			referrer_domain: string;
			utm_source: string;
			utm_medium: string;
			utm_campaign: string;
			views: number;
			visitors: number;
		}>;
	} = {},
) {
	const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
	const siteFailures: SiteFailure[] = [];
	let onFailedSiteFetch: (() => void) | undefined;
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, init });
		const path = new URL(url).pathname;
		if (path.endsWith("/v1/read/site")) {
			const failure = siteFailures.shift();
			if (failure) {
				onFailedSiteFetch?.();
				if (failure === "network")
					throw new TypeError(`socket failed while handling ${privateKey}`);
				if (failure === "timeout") {
					return await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					});
				}
				return new Response(
					JSON.stringify({ error: { code: "UPSTREAM_ERROR" }, detail: privateKey }),
					{
						status: failure,
						headers: {
							"content-type": "application/json",
							...(failure === 429 ? { "retry-after": "21" } : {}),
						},
					},
				);
			}
			return new Response(JSON.stringify(options.site ?? site), {
				status: options.siteStatus ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (
			options.analyticsStatus &&
			options.analyticsStatus !== 200 &&
			(!options.analyticsFailurePath || path.endsWith(options.analyticsFailurePath))
		) {
			return new Response(
				JSON.stringify({
					error: {
						code:
							options.analyticsErrorCode ??
							(options.analyticsStatus === 403 ? "FORBIDDEN" : "UNAVAILABLE"),
					},
					detail: privateKey,
				}),
				{
					status: options.analyticsStatus,
					headers: {
						"content-type": "application/json",
						...(options.analyticsStatus === 429 ? { "retry-after": "21" } : {}),
					},
				},
			);
		}
		const parsedUrl = new URL(url);
		const resolution = parsedUrl.searchParams.get("resolution");
		const timezone = parsedUrl.searchParams.get("timezone");
		if (path.endsWith("/overview") && resolution === "day" && timezone !== "UTC") {
			return new Response(JSON.stringify({ error: { code: "RESOLUTION_NOT_AVAILABLE" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}
		const meta = responseMeta();
		if (options.freshnessState) meta.freshness.state = options.freshnessState;
		meta.requested_range.from = parsedUrl.searchParams.get("from") ?? meta.requested_range.from;
		meta.requested_range.to = parsedUrl.searchParams.get("to") ?? meta.requested_range.to;
		meta.effective_range.from = meta.requested_range.from;
		meta.effective_range.to = meta.requested_range.to;
		meta.timezone = timezone ?? "UTC";
		meta.resolution = resolution ?? "day";
		if (options.missingFreshness) delete (meta as { freshness?: unknown }).freshness;
		const comparisonRange = parsedUrl.searchParams.get("compare") === "true";
		const comparisonRangeMeta = comparisonRange
			? (() => {
					const duration =
						Date.parse(meta.requested_range.to) - Date.parse(meta.requested_range.from);
					return {
						from: new Date(Date.parse(meta.requested_range.from) - duration).toISOString(),
						to: meta.requested_range.from,
					};
				})()
			: null;
		const responseMetadata = { ...meta, comparison_range: comparisonRangeMeta };
		const body = path.endsWith("/overview")
			? {
					meta: responseMetadata,
					totals: { events: 1200, pageviews: 980, visitors: 380, billable_events: 1150 },
					comparison: comparisonRange
						? { totals: { events: 1100, pageviews: 900, visitors: 350, billable_events: 1000 } }
						: null,
				}
			: path.endsWith("/timeseries")
				? {
						meta: responseMetadata,
						series: [
							{ bucket: meta.effective_range.from, events: 30, pageviews: 25, visitors: 20 },
						],
						comparison: null,
					}
				: path.endsWith("/analytics/pages")
					? {
							meta: responseMetadata,
							items: options.emptyReports
								? []
								: [
										{
											page_path: "/blog/openanalytics",
											views: 712,
											visitors: 518,
											entrances: 80,
											exits: 42,
											bounces: 20,
											bounce_rate: 0.25,
											ignored: privateKey,
										},
									],
						}
					: {
							meta: responseMetadata,
							items: options.emptyReports
								? []
								: (options.sourceRows ?? [
										{
											referrer_domain: "reddit.com",
											utm_source: "reddit",
											utm_medium: "social",
											utm_campaign: "launch",
											views: 301,
											visitors: 230,
											ignored: privateKey,
										},
									]),
						};
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return {
		fetchMock,
		requests,
		setSite(value: unknown) {
			options.site = value;
		},
		failNextSite(failure: SiteFailure, onFetch?: () => void) {
			siteFailures.push(failure);
			onFailedSiteFetch = onFetch;
		},
	};
}

async function renderedTracking(runtime: EmDashRuntime) {
	const result = await runtime.hooks.runPageFragments({
		page: { path: "/articles/example" },
	} as never);
	return renderFragments(
		result.flatMap(({ contributions }) => contributions),
		"head",
	);
}

async function validate(
	runtime: EmDashRuntime,
	options: { role?: number; tokenScopes?: string[]; body?: string; contentLength?: boolean } = {},
) {
	const response = await dispatchPluginApiRequest({
		runtime,
		pluginId,
		path: "validate-connection",
		request: new Request(`https://cms.test/_emdash/api/plugins/${pluginId}/validate-connection`, {
			method: "POST",
			...(options.body === undefined || options.contentLength !== true
				? {}
				: { headers: { "content-length": String(Buffer.byteLength(options.body)) } }),
			...(options.body === undefined ? {} : { body: options.body }),
		}),
		...(options.role === undefined
			? {}
			: {
					user: {
						id: `user-${options.role}`,
						email: "admin@example.test",
						name: "Admin",
						role: options.role,
						createdAt: new Date().toISOString(),
					},
				}),
		...(options.tokenScopes === undefined ? {} : { tokenScopes: options.tokenScopes }),
	} as never);
	return response;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	await Promise.all(
		runtimes.splice(0).map(async ({ runtime, directory }) => {
			await runtime.shutdown();
			rmSync(directory, { recursive: true, force: true });
		}),
	);
});

describe("OpenAnalytics native admin page", () => {
	it.each([
		`https://api.openanalytics.test/${privateKey}`,
		"https://api.openanalytics.test/%6fa%5fsk%5fadmin_test_private_key",
	])("never reflects credentials embedded in an invalid API URL", async (unsafeApiUrl) => {
		const runtime = await makeRuntime();
		const { fetchMock } = installFetch();
		await setSettings(runtime, { apiUrl: unsafeApiUrl, privateReadKey: privateKey });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		const output = JSON.stringify(result.data);
		expect(output).toContain("Invalid API URL");
		expect(output).not.toContain(privateKey);
		expect(output).not.toContain(unsafeApiUrl);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports an invalid analytics timezone without changing the working tracker", async () => {
		const runtime = await makeRuntime();
		const { fetchMock } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			timezone: "Mars/Olympus_Mons",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(result.data)).toContain("Analytics timezone is invalid");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it("preserves tracking after a rate limit on the standalone validation route", async () => {
		const runtime = await makeRuntime();
		const { failNextSite } = installFetch();
		await setSettings(runtime, { apiUrl, privateReadKey: privateKey });
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		failNextSite(429);
		const response = await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		expect((await response.json()).data).toMatchObject({
			success: false,
			error: { kind: "rate_limited" },
		});
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it("bounds standalone validation request bodies before upstream calls", async () => {
		const runtime = await makeRuntime();
		const { fetchMock } = installFetch();
		await setSettings(runtime, { apiUrl, privateReadKey: privateKey });
		const oversized = await validate(runtime, {
			role: 50,
			tokenScopes: ["admin"],
			body: "x".repeat(5_000),
			contentLength: true,
		});
		expect(oversized.status).toBe(413);
		expect(fetchMock).not.toHaveBeenCalled();
		const streamed = await validate(runtime, {
			role: 50,
			tokenScopes: ["admin"],
			body: "x".repeat(5_000),
		});
		expect(streamed.status).toBe(413);
		expect(fetchMock).not.toHaveBeenCalled();

		const emptyBody = await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		expect(emptyBody.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("requires the protected admin route and rejects CSRF and insufficient roles", async () => {
		const runtime = await makeRuntime();
		const { fetchMock } = installFetch();
		const unauthenticated = await dispatchAdmin(runtime, { type: "page_load", page: "/analytics" });
		expect(unauthenticated.response.status).toBe(401);
		const denied = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 40, tokenScopes: ["admin"] },
		);
		expect(denied.response.status).toBe(403);
		const csrf = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50 },
		);
		expect(csrf.response.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("restricts the admin page to POST and bounds interaction bodies", async () => {
		const runtime = await makeRuntime();
		const { fetchMock } = installFetch();
		const options = {
			runtime,
			pluginId,
			path: "admin",
			user: {
				id: "admin",
				email: "admin@example.test",
				name: "Admin",
				role: 50,
				createdAt: new Date().toISOString(),
			},
			tokenScopes: ["admin"],
		};
		const get = await dispatchPluginApiRequest({
			...options,
			request: new Request(`https://cms.test/_emdash/api/plugins/${pluginId}/admin`, {
				method: "GET",
			}),
		});
		expect(get.status).toBe(405);
		const oversized = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics", ignored: "x".repeat(5_000) },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(oversized.response.status).toBe(413);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shows missing configuration without calls and automatically validates changed settings", async () => {
		const runtime = await makeRuntime();
		const { fetchMock, requests, failNextSite } = installFetch();
		const unconfigured = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(unconfigured.response.status).toBe(200);
		expect(JSON.stringify(unconfigured.data)).toContain("Not configured");
		expect(JSON.stringify(unconfigured.data)).toContain("private read key");
		expect(JSON.stringify(unconfigured.data)).not.toContain("Refresh connection");
		expect(JSON.stringify(unconfigured.data)).not.toContain("Retry connection");
		expect(fetchMock).not.toHaveBeenCalled();

		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "America/New_York",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		await setSettings(runtime, {
			apiUrl: "https://new-api.openanalytics.test",
			trackingEnabled: true,
		});
		const refreshed = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(refreshed.data)).toContain("Connected");
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(JSON.stringify(refreshed.data)).not.toContain(privateKey);
		failNextSite("network");
		const failedRevalidation = await dispatchAdmin(
			runtime,
			{
				type: "block_action",
				action_id: "revalidate",
				value: { range: "30d" },
				page: "/analytics",
			},
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(failedRevalidation.data)).not.toContain(privateKey);
		const remainsConnected = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(remainsConnected.data)).toContain("Connected");
		expect(requests.filter(({ url }) => url.includes("analytics/"))).toHaveLength(8);
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it("automatically validates once on first page load, then range changes and revisits reuse the snapshot", async () => {
		const runtime = await makeRuntime();
		const { requests } = installFetch();
		await setSettings(runtime, { apiUrl, privateReadKey: privateKey, trackingEnabled: true });
		const first = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{
				role: 50,
				tokenScopes: ["admin"],
			},
		);
		expect(JSON.stringify(first.data)).toContain("Connected");
		expect(JSON.stringify(first.data)).toContain("Visitors");
		const blocks = first.data.blocks ?? [];
		const connectionButtonIndex = blocks.findIndex(
			(block) => block.type === "actions" && JSON.stringify(block).includes("Refresh connection"),
		);
		const rangeIndex = blocks.findIndex(
			(block) => block.type === "actions" && JSON.stringify(block).includes('"label":"Date range"'),
		);
		expect(connectionButtonIndex).toBeGreaterThan(-1);
		expect(rangeIndex).toBeGreaterThan(connectionButtonIndex);
		expect(JSON.stringify(blocks[rangeIndex])).not.toContain("revalidate");
		expect(requests.filter(({ url }) => url.endsWith("/v1/read/site"))).toHaveLength(1);
		expect(requests.filter(({ url }) => url.includes("analytics/"))).toHaveLength(4);
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
		await dispatchAdmin(
			runtime,
			{ type: "block_action", action_id: "range", value: "7d", page: "/analytics" },
			{
				role: 50,
				tokenScopes: ["admin"],
			},
		);
		const afterRange = requests.filter(({ url }) => url.includes("analytics/")).slice(-4);
		for (const { url } of afterRange) {
			expect(Date.now() - Date.parse(new URL(url).searchParams.get("from")!)).toBeLessThan(
				8 * 24 * 60 * 60 * 1000,
			);
		}
		const refresh = await dispatchAdmin(
			runtime,
			{ type: "block_action", action_id: "revalidate", value: { range: "7d" }, page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(refresh.data)).toContain("Connected");
		const afterRefresh = requests.filter(({ url }) => url.includes("analytics/")).slice(-4);
		for (const { url } of afterRefresh) {
			expect(Date.now() - Date.parse(new URL(url).searchParams.get("from")!)).toBeLessThan(
				8 * 24 * 60 * 60 * 1000,
			);
		}
		await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{
				role: 50,
				tokenScopes: ["admin"],
			},
		);
		expect(requests.filter(({ url }) => url.endsWith("/v1/read/site"))).toHaveLength(2);
		expect(requests.filter(({ url }) => url.includes("analytics/"))).toHaveLength(16);
	});

	it("suppresses a stale tracker on configuration mismatch until the new pair validates", async () => {
		const runtime = await makeRuntime();
		const { requests } = installFetch();
		await setSettings(runtime, { apiUrl, privateReadKey: privateKey, trackingEnabled: true });
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');

		const changedKey = "oa_sk_admin_test_changed_private_key";
		await setSettings(runtime, {
			apiUrl: "https://new-api.openanalytics.test",
			privateReadKey: changedKey,
			trackingEnabled: true,
		});
		expect(await renderedTracking(runtime)).toBe("");
		const beforeLoad = requests.length;
		const page = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(page.data)).toContain("Connected");
		expect(
			requests.slice(beforeLoad).filter(({ url }) => url.endsWith("/v1/read/site")),
		).toHaveLength(1);
		expect(requests.slice(beforeLoad).filter(({ url }) => url.includes("analytics/"))).toHaveLength(
			4,
		);
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it("does not retry a failed changed configuration until explicit retry, then recovers", async () => {
		const runtime = await makeRuntime();
		const { requests, failNextSite } = installFetch();
		await setSettings(runtime, { apiUrl, privateReadKey: privateKey, trackingEnabled: true });
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		await setSettings(runtime, {
			apiUrl: "https://new-api.openanalytics.test",
			privateReadKey: "oa_sk_admin_test_changed_private_key",
			trackingEnabled: true,
		});
		failNextSite("network");
		const failed = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(failed.data)).toContain("Retry connection");
		expect(await renderedTracking(runtime)).toBe("");
		const afterFailure = requests.length;
		for (const interaction of [
			{ type: "page_load", page: "/analytics" },
			{ type: "block_action", action_id: "range", value: "7d", page: "/analytics" },
		]) {
			await dispatchAdmin(runtime, interaction, { role: 50, tokenScopes: ["admin"] });
		}
		expect(requests).toHaveLength(afterFailure);
		expect(await renderedTracking(runtime)).toBe("");
		const retried = await dispatchAdmin(
			runtime,
			{ type: "block_action", action_id: "revalidate", value: { range: "7d" }, page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(retried.data)).toContain("Connected");
		expect(
			requests.slice(afterFailure).filter(({ url }) => url.endsWith("/v1/read/site")),
		).toHaveLength(1);
		expect(
			requests.slice(afterFailure).filter(({ url }) => url.includes("analytics/")),
		).toHaveLength(4);
		expect(
			requests
				.slice(afterFailure)
				.filter(({ url }) => url.includes("analytics/"))
				.every(
					({ url }) =>
						new URL(url).searchParams.get("from") &&
						Date.parse(new URL(url).searchParams.get("from")!) >
							Date.now() - 8 * 24 * 60 * 60 * 1000,
				),
		).toBe(true);
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it("shows a safe retry after automatic validation fails and makes no analytics reads", async () => {
		const runtime = await makeRuntime();
		const { requests, failNextSite } = installFetch();
		await setSettings(runtime, { apiUrl, privateReadKey: privateKey });
		failNextSite(401);
		const failed = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{
				role: 50,
				tokenScopes: ["admin"],
			},
		);
		const failedText = JSON.stringify(failed.data);
		expect(failedText).toContain("Connection failed");
		expect(failedText).toContain("Retry connection");
		expect(failedText).toContain("rejected this credential");
		expect(failedText).not.toContain(privateKey);
		expect(requests.filter(({ url }) => url.includes("analytics/"))).toHaveLength(0);
		expect(await renderedTracking(runtime)).toBe("");
		const revisited = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{
				role: 50,
				tokenScopes: ["admin"],
			},
		);
		expect(JSON.stringify(revisited.data)).toContain("Retry connection");
		expect(requests.filter(({ url }) => url.endsWith("/v1/read/site"))).toHaveLength(1);
		const retried = await dispatchAdmin(
			runtime,
			{ type: "block_action", action_id: "revalidate", page: "/analytics" },
			{
				role: 50,
				tokenScopes: ["admin"],
			},
		);
		expect(JSON.stringify(retried.data)).toContain("Connected");
		expect(requests.filter(({ url }) => url.endsWith("/v1/read/site"))).toHaveLength(2);
	});

	it("loads useful native blocks, emits explicit range and timezone, and never returns the private key", async () => {
		const runtime = await makeRuntime();
		const { fetchMock, requests } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "America/New_York",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const loaded = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(loaded.response.status).toBe(200);
		expect(loaded.data.blocks).toBeDefined();
		expect(validateBlockResponse(loaded.data, { pluginPagePaths: ["/analytics"] }).valid).toBe(
			true,
		);
		const output = JSON.stringify(loaded.data);
		expect(output).toContain("Connected");
		expect(output).toContain("Tracking active");
		expect(output).toContain("Visitors");
		expect(output).toContain("Pageviews");
		expect(output).toContain("Latest rolled-up data");
		expect(output).toContain("Previous period: 350");
		expect(output).toContain("Previous period: 900");
		expect(output).not.toContain(privateKey);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(output).toContain("Top Pages");
		expect(output).toContain("/blog/openanalytics");
		expect(output).toContain("Traffic Sources");
		expect(output).toContain("reddit.com");
		expect(output).toContain("medium: social");
		for (const { url, init } of requests) {
			expect(url).not.toContain(privateKey);
			if (url.includes("analytics/")) {
				const parsed = new URL(url);
				expect(parsed.searchParams.get("from")).toBeTruthy();
				expect(parsed.searchParams.get("to")).toBeTruthy();
				expect(parsed.searchParams.get("timezone")).toBe("America/New_York");
				expect(parsed.searchParams.get("resolution")).toBe(
					parsed.pathname.endsWith("/overview") || parsed.pathname.endsWith("/timeseries")
						? parsed.pathname.endsWith("/overview")
							? "hour"
							: "day"
						: null,
				);
				expect(parsed.searchParams.get("compare")).toBe(
					parsed.pathname.endsWith("/overview") ? "true" : null,
				);
				expect(init?.headers).toMatchObject({ Authorization: `Bearer ${privateKey}` });
			}
		}
		const firstRangeQueries = requests
			.filter(({ url }) => url.includes("analytics/"))
			.map(({ url }) => new URL(url));
		expect(firstRangeQueries).toHaveLength(4);
		for (const query of firstRangeQueries) {
			expect(query.searchParams.get("from")).toBe(firstRangeQueries[0]!.searchParams.get("from"));
			expect(query.searchParams.get("to")).toBe(firstRangeQueries[0]!.searchParams.get("to"));
			expect(query.searchParams.get("timezone")).toBe("America/New_York");
		}
		const hourly = await dispatchAdmin(
			runtime,
			{ type: "block_action", action_id: "range", value: "24h", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(hourly.response.status).toBe(200);
		const analyticsRequests = requests.filter(({ url }) => url.includes("analytics/"));
		const lastPair = analyticsRequests.slice(-4).map(({ url }) => new URL(url));
		const recentQuery = lastPair[0]!;
		const from = Date.parse(recentQuery.searchParams.get("from")!);
		const to = Date.parse(recentQuery.searchParams.get("to")!);
		expect(to - from).toBeCloseTo(24 * 60 * 60 * 1000, -2);
		expect(recentQuery.searchParams.get("resolution")).toBe("hour");
		expect(recentQuery.searchParams.get("timezone")).toBe("America/New_York");
		expect(lastPair[1]!.searchParams.get("from")).toBe(recentQuery.searchParams.get("from"));
		expect(lastPair[1]!.searchParams.get("to")).toBe(recentQuery.searchParams.get("to"));
		expect(recentQuery.searchParams.get("compare")).toBe("true");
		expect(lastPair[1]!.searchParams.has("compare")).toBe(false);
		expect(JSON.stringify(hourly.data)).not.toContain(privateKey);

		for (const [preset, days] of [
			["7d", 7],
			["30d", 30],
			["90d", 90],
		] as const) {
			const selected = await dispatchAdmin(
				runtime,
				{ type: "block_action", action_id: "range", value: preset, page: "/analytics" },
				{ role: 50, tokenScopes: ["admin"] },
			);
			expect(selected.response.status).toBe(200);
			const pair = requests
				.filter(({ url }) => url.includes("analytics/"))
				.slice(-4)
				.map(({ url }) => new URL(url));
			const byPath = (suffix: string) => pair.find((item) => item.pathname.endsWith(suffix))!;
			const rangeMs =
				Date.parse(byPath("/overview").searchParams.get("to")!) -
				Date.parse(byPath("/overview").searchParams.get("from")!);
			expect(rangeMs).toBeCloseTo(days * 24 * 60 * 60 * 1000, -2);
			expect(byPath("/overview").searchParams.get("resolution")).toBe("hour");
			expect(byPath("/timeseries").searchParams.get("resolution")).toBe("day");
			for (const reportPath of ["/pages", "/sources"]) {
				const report = byPath(reportPath);
				expect(report.searchParams.get("from")).toBe(byPath("/overview").searchParams.get("from"));
				expect(report.searchParams.get("to")).toBe(byPath("/overview").searchParams.get("to"));
				expect(report.searchParams.get("timezone")).toBe("America/New_York");
				expect(report.searchParams.get("limit")).toBe("10");
				expect(report.searchParams.has("resolution")).toBe(false);
			}
			expect(byPath("/timeseries").searchParams.get("from")).toBe(
				byPath("/overview").searchParams.get("from"),
			);
			expect(byPath("/timeseries").searchParams.get("to")).toBe(
				byPath("/overview").searchParams.get("to"),
			);
			expect(byPath("/overview").searchParams.get("compare")).toBe("true");
			expect(byPath("/timeseries").searchParams.has("compare")).toBe(false);
			expect(JSON.stringify(selected.data)).toContain(`Last ${days} days`);
		}
	});

	it("shows connected without a tracking key and handles missing freshness gracefully", async () => {
		const runtime = await makeRuntime();
		const { requests } = installFetch({
			site: { ...site, install: { ...site.install, tracking_key: null } },
			missingFreshness: true,
		});
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(result.data)).toContain("No tracking key");
		expect(requests.some(({ url }) => url.includes("analytics/"))).toBe(true);
	});

	it("renders empty report states as native tables with no pagination controls", async () => {
		const runtime = await makeRuntime();
		installFetch({ emptyReports: true });
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		const text = JSON.stringify(result.data);
		expect(text).toContain("No page activity in this range.");
		expect(text).toContain("No traffic sources recorded in this range.");
		const tables = (result.data.blocks?.filter((block) => block.type === "table") ?? []) as Array<{
			rows?: unknown[];
			next_cursor?: unknown;
			columns?: Array<{ sortable?: boolean }>;
		}>;
		expect(tables).toHaveLength(2);
		for (const table of tables) {
			expect(table.rows).toEqual([]);
			expect(table.next_cursor).toBeUndefined();
			expect(table.columns?.some((column: { sortable?: boolean }) => column.sortable)).toBe(false);
		}
		expect(validateBlockResponse(result.data, { pluginPagePaths: ["/analytics"] }).valid).toBe(
			true,
		);
	});

	it("labels tagged traffic without misclassifying it as direct or internal", async () => {
		const runtime = await makeRuntime();
		installFetch({
			sourceRows: [
				{
					referrer_domain: "",
					utm_source: "newsletter",
					utm_medium: "email",
					utm_campaign: "launch",
					views: 42,
					visitors: 31,
				},
				{
					referrer_domain: "",
					utm_source: "",
					utm_medium: "paid",
					utm_campaign: "spring",
					views: 12,
					visitors: 8,
				},
				{
					referrer_domain: "",
					utm_source: "",
					utm_medium: "",
					utm_campaign: "",
					views: 5,
					visitors: 4,
				},
			],
		});
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		const table = result.data.blocks?.find(
			(block) => block.type === "table" && JSON.stringify(block.columns).includes('"source"'),
		);
		const text = JSON.stringify(table);
		expect(text).toContain("newsletter · medium: email · campaign: launch");
		expect(text).toContain("No referrer · medium: paid · campaign: spring");
		expect(text).toContain("Direct / internal");
		expect(text).not.toContain("Direct / internal · newsletter");
	});

	it.each([
		[
			"/v1/read/analytics/pages",
			"Top pages temporarily unavailable.",
			"Traffic Sources",
			"reddit.com",
		],
		[
			"/v1/read/analytics/sources",
			"Traffic sources temporarily unavailable.",
			"/blog/openanalytics",
			"Visitors",
		],
	] as const)(
		"isolates report failure for %s",
		async (failurePath, sectionMessage, visiblePage, otherReport) => {
			const runtime = await makeRuntime();
			installFetch({ analyticsStatus: 503, analyticsFailurePath: failurePath });
			await setSettings(runtime, {
				apiUrl,
				privateReadKey: privateKey,
				trackingEnabled: true,
				timezone: "UTC",
			});
			await validate(runtime, { role: 50, tokenScopes: ["admin"] });
			const result = await dispatchAdmin(
				runtime,
				{ type: "page_load", page: "/analytics" },
				{ role: 50, tokenScopes: ["admin"] },
			);
			const output = JSON.stringify(result.data);
			expect(output).toContain("Visitors");
			expect(output).toContain(visiblePage);
			expect(output).toContain(otherReport);
			expect(output).toContain(sectionMessage);
			expect(output).not.toContain(privateKey);
		},
	);

	it.each([
		["/overview", "Overview unavailable", "Chart covers", "reddit.com"],
		["/timeseries", "Chart unavailable", "Previous period: 350", "/blog/openanalytics"],
	] as const)(
		"keeps the other analytics sections visible when %s fails",
		async (failurePath, message, survivingOverview, survivingReport) => {
			const runtime = await makeRuntime();
			installFetch({ analyticsStatus: 503, analyticsFailurePath: failurePath });
			await setSettings(runtime, {
				apiUrl,
				privateReadKey: privateKey,
				trackingEnabled: true,
				timezone: "UTC",
			});
			await validate(runtime, { role: 50, tokenScopes: ["admin"] });
			const result = await dispatchAdmin(
				runtime,
				{ type: "page_load", page: "/analytics" },
				{ role: 50, tokenScopes: ["admin"] },
			);
			const output = JSON.stringify(result.data);
			expect(output).toContain(message);
			expect(output).toContain(survivingOverview);
			expect(output).toContain(survivingReport);
			expect(output).not.toContain(privateKey);
		},
	);

	it("shows tracker installation separately from suspended collection state", async () => {
		const runtime = await makeRuntime();
		installFetch({ site: { ...site, status: "suspended" } });
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(result.data)).toContain("Tracker installed · collection suspended");
		expect(JSON.stringify(result.data)).not.toContain("Tracking inactive");
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it.each([
		[403, "This private key does not have analytics:read permission."],
		[402, "OpenAnalytics paused this request because of a billing or service issue."],
		[429, "OpenAnalytics rate limit reached. Try again in 21 seconds."],
		[503, "OpenAnalytics is temporarily unavailable. Try again shortly."],
	] as const)("renders a safe analytics error state for HTTP %i", async (status, message) => {
		const runtime = await makeRuntime();
		installFetch({ analyticsStatus: status });
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(result.data)).toContain(message);
		expect(JSON.stringify(result.data)).toContain("Tracking active");
		expect(JSON.stringify(result.data)).not.toContain(privateKey);
		expect(JSON.stringify(result.data)).not.toContain("UNAVAILABLE");
	});

	it("explains the suspended-site analytics gate", async () => {
		const runtime = await makeRuntime();
		installFetch({ analyticsStatus: 403, analyticsErrorCode: "SITE_SUSPENDED" });
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(result.data)).toContain("This OpenAnalytics site is suspended");
	});

	it.each([
		["stale", "delayed"],
		["degraded", "status unavailable"],
	] as const)(
		"shows a delayed-data notice when freshness is %s",
		async (freshnessState, displayState) => {
			const runtime = await makeRuntime();
			installFetch({ freshnessState });
			await setSettings(runtime, {
				apiUrl,
				privateReadKey: privateKey,
				trackingEnabled: true,
				timezone: "UTC",
			});
			await validate(runtime, { role: 50, tokenScopes: ["admin"] });
			const result = await dispatchAdmin(
				runtime,
				{ type: "page_load", page: "/analytics" },
				{ role: 50, tokenScopes: ["admin"] },
			);
			expect(JSON.stringify(result.data)).toContain("Results may be delayed or incomplete");
			expect(JSON.stringify(result.data)).toContain(`totals ${displayState}`);
		},
	);

	it("shows 'Not recorded' for a valid scaffold snapshot without validation time", async () => {
		const runtime = await makeRuntime();
		installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		const optionName = `plugin:${pluginId}:state:validated-site`;
		const option = await runtime.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", optionName)
			.executeTakeFirstOrThrow();
		const snapshot = JSON.parse(option.value) as Record<string, unknown>;
		delete snapshot.validatedAt;
		await runtime.db
			.updateTable("options")
			.set({ value: JSON.stringify(snapshot) })
			.where("name", "=", optionName)
			.execute();
		const result = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(result.data)).toContain("Not recorded");
	});

	it("uses EmDash authentication for revalidation, refreshes the public snapshot, and returns no secret", async () => {
		const runtime = await makeRuntime();
		const { fetchMock } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		const unauthorized = await dispatchAdmin(runtime, {
			type: "block_action",
			action_id: "revalidate",
			value: { range: "30d" },
			page: "/analytics",
		});
		expect(unauthorized.response.status).toBe(401);
		const denied = await dispatchAdmin(
			runtime,
			{
				type: "block_action",
				action_id: "revalidate",
				value: { range: "30d" },
				page: "/analytics",
			},
			{ role: 40, tokenScopes: ["admin"] },
		);
		expect(denied.response.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
		const validated = await dispatchAdmin(
			runtime,
			{
				type: "block_action",
				action_id: "revalidate",
				value: { range: "30d" },
				page: "/analytics",
			},
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(validated.response.status).toBe(200);
		expect(JSON.stringify(validated.data)).toContain("Connected");
		expect(JSON.stringify(validated.data)).not.toContain(privateKey);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("keeps a matching validated snapshot through transient revalidation failures", async () => {
		const runtime = await makeRuntime();
		const { fetchMock, failNextSite } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });

		for (const failure of ["network", 429, 500, 503] as const) {
			failNextSite(failure);
			const result = await dispatchAdmin(
				runtime,
				{
					type: "block_action",
					action_id: "revalidate",
					value: { range: "30d" },
					page: "/analytics",
				},
				{ role: 50, tokenScopes: ["admin"] },
			);
			expect(result.response.status).toBe(200);
			const text = JSON.stringify(result.data);
			expect(text).toContain("Revalidation failed");
			expect(text).toContain("Tracking active");
			expect(text).not.toContain(privateKey);
			expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
			const page = await dispatchAdmin(
				runtime,
				{ type: "page_load", page: "/analytics" },
				{ role: 50, tokenScopes: ["admin"] },
			);
			expect(JSON.stringify(page.data)).toContain("Tracking active");
			expect(page.response.status).toBe(200);
			expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
		}
		expect(fetchMock.mock.calls.every(([input]) => !String(input).includes(privateKey))).toBe(true);
	});

	it("clears a revoked credential snapshot after a 401 revalidation", async () => {
		const runtime = await makeRuntime();
		const { requests, failNextSite } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		failNextSite(401);
		const failed = await dispatchAdmin(
			runtime,
			{
				type: "block_action",
				action_id: "revalidate",
				value: { range: "30d" },
				page: "/analytics",
			},
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(failed.data)).toContain("OpenAnalytics rejected this credential");
		expect(await renderedTracking(runtime)).toBe("");
		const before = requests.length;
		const page = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(JSON.stringify(page.data)).toContain("Retry connection");
		expect(requests).toHaveLength(before);
	});

	it("keeps the current snapshot after a timeout and preserves error context", async () => {
		const runtime = await makeRuntime();
		const { failNextSite } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });

		let enteredResolve!: () => void;
		const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
		failNextSite("timeout", enteredResolve);
		vi.useFakeTimers();
		const request = dispatchAdmin(
			runtime,
			{
				type: "block_action",
				action_id: "revalidate",
				value: { range: "30d" },
				page: "/analytics",
			},
			{ role: 50, tokenScopes: ["admin"] },
		);
		await entered;
		await vi.advanceTimersByTimeAsync(5_100);
		const result = await request;
		vi.useRealTimers();
		expect(JSON.stringify(result.data)).toContain("Revalidation failed");
		expect(JSON.stringify(result.data)).toContain("Tracking active");
		const page = await dispatchAdmin(
			runtime,
			{ type: "page_load", page: "/analytics" },
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(page.response.status).toBe(200);
		expect(JSON.stringify(page.data)).toContain("Tracking active");
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
	});

	it("revalidation atomically replaces the validated public tracker metadata", async () => {
		const runtime = await makeRuntime();
		const { setSite } = installFetch();
		await setSettings(runtime, {
			apiUrl,
			privateReadKey: privateKey,
			trackingEnabled: true,
			timezone: "UTC",
		});
		await validate(runtime, { role: 50, tokenScopes: ["admin"] });
		expect(await renderedTracking(runtime)).toContain('data-key="oa_pk_admin_public"');
		setSite({
			...site,
			name: "Documentation v2",
			install: { ...site.install, tracking_key: "oa_pk_revalidated" },
		});
		const refreshed = await dispatchAdmin(
			runtime,
			{
				type: "block_action",
				action_id: "revalidate",
				value: { range: "30d" },
				page: "/analytics",
			},
			{ role: 50, tokenScopes: ["admin"] },
		);
		expect(refreshed.response.status).toBe(200);
		const html = await renderedTracking(runtime);
		expect(html).toContain('data-key="oa_pk_revalidated"');
		expect(html).not.toContain('data-key="oa_pk_admin_public"');
		expect(html).not.toContain("oa_sk_");
	});
});
