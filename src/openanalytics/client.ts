import { type OpenAnalyticsConfig, parseConfiguration } from "../settings/config";
import { analyticsErrorForStatus, errorForStatus, OpenAnalyticsError } from "./errors";
import type {
	AnalyticsDateRange,
	AnalyticsFreshness,
	AnalyticsMeta,
	AnalyticsOverviewResponse,
	AnalyticsReadQuery,
	AnalyticsTimeseriesResponse,
	OverviewTotals,
	SiteReadContext,
	TimeseriesPoint,
} from "./types";

const PRIVATE_KEY_VALUE = /oa_sk_[A-Za-z0-9_-]+/i;
const SITE_STATUSES = new Set(["active", "suspended", "deleting", "deleted"]);
const RESOLUTIONS = new Set(["minute", "hour", "day", "week"]);
const FRESHNESS_STATES = new Set(["ok", "no_data", "stale", "degraded"]);
const ISO_UTC_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

export function containsPrivateKey(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value === "string") {
		let decoded = value;
		for (let i = 0; i < 3; i += 1) {
			if (PRIVATE_KEY_VALUE.test(decoded)) return true;
			try {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			} catch {
				break;
			}
		}
		return PRIVATE_KEY_VALUE.test(decoded);
	}
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	return Object.values(value as Record<string, unknown>).some((item) =>
		containsPrivateKey(item, seen),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUtcInstant(value: unknown): value is string {
	return (
		typeof value === "string" &&
		ISO_UTC_INSTANT.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
	);
}

function isDateRange(value: unknown): value is AnalyticsDateRange {
	return (
		isRecord(value) &&
		isUtcInstant(value.from) &&
		isUtcInstant(value.to) &&
		Date.parse(value.from) < Date.parse(value.to)
	);
}

function isTimezone(value: unknown): value is string {
	if (!isNonEmptyString(value) || value.length > 64) return false;
	try {
		const formatter = new Intl.DateTimeFormat("en", { timeZone: value });
		void formatter;
		return true;
	} catch {
		return false;
	}
}

export function isSiteReadContext(value: unknown): value is SiteReadContext {
	if (!isRecord(value) || !isRecord(value.install)) return false;
	const install = value.install;
	return (
		isNonEmptyString(value.site_id) &&
		typeof value.slug === "string" &&
		typeof value.name === "string" &&
		typeof value.status === "string" &&
		SITE_STATUSES.has(value.status) &&
		nullableString(install.tracking_key) &&
		nullableString(install.script_url) &&
		nullableString(install.collector_url)
	);
}

function isTotals(value: unknown): value is OverviewTotals {
	return (
		isRecord(value) &&
		isCount(value.events) &&
		isCount(value.pageviews) &&
		isCount(value.visitors) &&
		isCount(value.billable_events)
	);
}

function isFreshness(value: unknown): value is AnalyticsFreshness {
	return (
		isRecord(value) &&
		typeof value.state === "string" &&
		FRESHNESS_STATES.has(value.state) &&
		(value.watermark === null || isUtcInstant(value.watermark)) &&
		isUtcInstant(value.as_of)
	);
}

function isMeta(value: unknown): value is AnalyticsMeta {
	return (
		isRecord(value) &&
		isDateRange(value.requested_range) &&
		isDateRange(value.effective_range) &&
		isTimezone(value.timezone) &&
		typeof value.resolution === "string" &&
		RESOLUTIONS.has(value.resolution) &&
		Array.isArray(value.data_sources) &&
		value.data_sources.length > 0 &&
		value.data_sources.every((source) => source === "live" || source === "imported") &&
		(value.accuracy === "exact" ||
			value.accuracy === "estimated" ||
			value.accuracy === "provider_defined") &&
		(value.freshness === undefined || value.freshness === null || isFreshness(value.freshness)) &&
		(value.comparison_range === null || isDateRange(value.comparison_range)) &&
		typeof value.truncated === "boolean" &&
		typeof value.cached === "boolean" &&
		typeof value.partial === "boolean"
	);
}

function isPoint(value: unknown): value is TimeseriesPoint {
	return (
		isRecord(value) &&
		isUtcInstant(value.bucket) &&
		isCount(value.events) &&
		isCount(value.pageviews) &&
		isCount(value.visitors)
	);
}

function projectRange(value: AnalyticsDateRange): AnalyticsDateRange {
	return Object.freeze({ from: value.from, to: value.to });
}

function projectMeta(value: AnalyticsMeta): AnalyticsMeta {
	return Object.freeze({
		requested_range: projectRange(value.requested_range),
		effective_range: projectRange(value.effective_range),
		timezone: value.timezone,
		resolution: value.resolution,
		data_sources: Object.freeze([...value.data_sources]),
		accuracy: value.accuracy,
		freshness:
			value.freshness === null || value.freshness === undefined
				? null
				: Object.freeze({
						state: value.freshness.state,
						watermark: value.freshness.watermark,
						as_of: value.freshness.as_of,
					}),
		comparison_range: value.comparison_range === null ? null : projectRange(value.comparison_range),
		truncated: value.truncated,
		cached: value.cached,
		partial: value.partial,
	});
}

function isAnalyticsReadQuery(value: AnalyticsReadQuery): boolean {
	if (
		!isUtcInstant(value.from) ||
		!isUtcInstant(value.to) ||
		Date.parse(value.from) >= Date.parse(value.to) ||
		!isTimezone(value.timezone) ||
		(value.compare !== undefined && typeof value.compare !== "boolean") ||
		(value.resolution !== "hour" && value.resolution !== "day")
	) {
		return false;
	}
	return true;
}

async function getJSON(
	config: OpenAnalyticsConfig,
	path: string,
	query?: AnalyticsReadQuery,
): Promise<unknown> {
	const validated = parseConfiguration(config);
	if (query && !isAnalyticsReadQuery(query)) {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics analytics query is invalid.");
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), validated.timeoutMs);
	try {
		const url = new URL(`${validated.apiUrl}${path}`);
		if (query) {
			url.searchParams.set("from", query.from);
			url.searchParams.set("to", query.to);
			url.searchParams.set("timezone", query.timezone);
			url.searchParams.set("resolution", query.resolution);
			if (query.compare !== undefined) url.searchParams.set("compare", String(query.compare));
		}
		const response = await fetch(url.toString(), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${validated.readKey}`,
				Accept: "application/json",
			},
			redirect: "error",
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) {
			let payload: unknown;
			if (query && (response.status === 400 || response.status === 403)) {
				try {
					payload = await response.json();
				} catch {
					if (controller.signal.aborted) throw new OpenAnalyticsError("timeout");
				}
			}
			throw query
				? analyticsErrorForStatus(response.status, response.headers.get("retry-after"), payload)
				: errorForStatus(response.status, response.headers.get("retry-after"));
		}
		try {
			return await response.json();
		} catch {
			if (controller.signal.aborted) throw new OpenAnalyticsError("timeout");
			throw new OpenAnalyticsError("invalid_response");
		}
	} catch (error) {
		if (error instanceof OpenAnalyticsError) throw error;
		if (controller.signal.aborted) throw new OpenAnalyticsError("timeout");
		throw new OpenAnalyticsError("network");
	} finally {
		clearTimeout(timeout);
	}
}

/** Read the site context associated with a private read key. */
export async function getSite(config: OpenAnalyticsConfig): Promise<SiteReadContext> {
	const payload = await getJSON(config, "/v1/read/site");
	if (!isSiteReadContext(payload)) throw new OpenAnalyticsError("invalid_response");
	const site = Object.freeze({
		site_id: payload.site_id,
		slug: payload.slug,
		name: payload.name,
		status: payload.status,
		install: Object.freeze({
			tracking_key: payload.install.tracking_key,
			script_url: payload.install.script_url,
			collector_url: payload.install.collector_url,
		}),
	});
	if (containsPrivateKey(site)) throw new OpenAnalyticsError("invalid_response");
	return site;
}

/** Read aggregate analytics using the key's server-side analytics:read scope. */
export async function getOverview(
	config: OpenAnalyticsConfig,
	query: AnalyticsReadQuery,
): Promise<AnalyticsOverviewResponse> {
	const payload = await getJSON(config, "/v1/read/analytics/overview", query);
	if (
		!isRecord(payload) ||
		!isMeta(payload.meta) ||
		!isTotals(payload.totals) ||
		!(
			payload.comparison === null ||
			(isRecord(payload.comparison) && isTotals(payload.comparison.totals))
		)
	) {
		throw new OpenAnalyticsError("invalid_response");
	}
	const comparison = payload.comparison;
	const result: AnalyticsOverviewResponse = Object.freeze({
		meta: projectMeta(payload.meta),
		totals: Object.freeze({
			events: payload.totals.events,
			pageviews: payload.totals.pageviews,
			visitors: payload.totals.visitors,
			billable_events: payload.totals.billable_events,
		}),
		comparison:
			comparison === null
				? null
				: Object.freeze({
						totals: Object.freeze({
							events: (comparison as { totals: OverviewTotals }).totals.events,
							pageviews: (comparison as { totals: OverviewTotals }).totals.pageviews,
							visitors: (comparison as { totals: OverviewTotals }).totals.visitors,
							billable_events: (comparison as { totals: OverviewTotals }).totals.billable_events,
						}),
					}),
	});
	if (containsPrivateKey(result)) throw new OpenAnalyticsError("invalid_response");
	return result;
}

/** Read chart buckets without client-side visitor reaggregation. */
export async function getTimeseries(
	config: OpenAnalyticsConfig,
	query: AnalyticsReadQuery,
): Promise<AnalyticsTimeseriesResponse> {
	const payload = await getJSON(config, "/v1/read/analytics/timeseries", query);
	const isPoints = (value: unknown): value is TimeseriesPoint[] =>
		Array.isArray(value) && value.every(isPoint);
	if (
		!isRecord(payload) ||
		!isMeta(payload.meta) ||
		!isPoints(payload.series) ||
		!(
			payload.comparison === null ||
			(isRecord(payload.comparison) && isPoints(payload.comparison.series))
		)
	) {
		throw new OpenAnalyticsError("invalid_response");
	}
	const comparison = payload.comparison;
	const projectPoints = (points: readonly TimeseriesPoint[]) =>
		Object.freeze(
			points.map((point) =>
				Object.freeze({
					bucket: point.bucket,
					events: point.events,
					pageviews: point.pageviews,
					visitors: point.visitors,
				}),
			),
		);
	const result: AnalyticsTimeseriesResponse = Object.freeze({
		meta: projectMeta(payload.meta),
		series: projectPoints(payload.series),
		comparison:
			comparison === null
				? null
				: Object.freeze({
						series: projectPoints((comparison as { series: TimeseriesPoint[] }).series),
					}),
	});
	if (containsPrivateKey(result)) throw new OpenAnalyticsError("invalid_response");
	return result;
}
