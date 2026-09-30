import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { RouteContext } from "emdash";

import {
	configurationFingerprint,
	configurationFromSettings,
	isSiteSnapshot,
	safeConnectionSummary,
	SITE_SNAPSHOT_KEY,
	type SiteSnapshot,
	validateConnection,
} from "../connection";
import { getOverview, getPages, getSources, getTimeseries } from "../openanalytics/client";
import { OpenAnalyticsError } from "../openanalytics/errors";
import type { AnalyticsReadQuery } from "../openanalytics/types";
import { DEFAULT_API_URL, type OpenAnalyticsConfig } from "../settings/config";
import { connectionBlocks, controls, displayApiUrl } from "./connection";
import { renderOverview } from "./overview";
import { queryFor, rangeLabel, RANGES, selectedRange, type DateRange } from "./ranges";
import { renderPages, renderSources } from "./reports";

type Input =
	| { type: "page_load"; page: string }
	| { type: "block_action"; action_id: string; value?: unknown; page?: string };

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseInput(value: unknown): Input | null {
	if (!record(value)) return null;
	if (value.type === "page_load" && value.page === "/analytics") return value as Input;
	if (
		value.type === "block_action" &&
		typeof value.action_id === "string" &&
		["range", "revalidate", "retry"].includes(value.action_id) &&
		(value.page === undefined || value.page === "/analytics")
	)
		return value as Input;
	return null;
}

function safeError(kind: unknown, retryAfterSeconds?: number): string {
	switch (kind) {
		case "analytics_forbidden":
			return "This private key does not have analytics:read permission.";
		case "suspended":
			return "This OpenAnalytics site is suspended, so analytics data is unavailable.";
		case "unauthorized":
			return "OpenAnalytics rejected this credential. Revalidate with a current private read key.";
		case "forbidden":
			return "This private key does not have permission to read OpenAnalytics data.";
		case "billing":
			return "OpenAnalytics paused this request because of a billing or service issue.";
		case "rate_limited":
			return retryAfterSeconds === undefined
				? "OpenAnalytics rate limit reached. Try again shortly."
				: `OpenAnalytics rate limit reached. Try again in ${retryAfterSeconds} seconds.`;
		case "range_invalid":
			return "OpenAnalytics could not provide data for this date range. Choose another range.";
		case "resolution_unavailable":
			return "OpenAnalytics cannot provide this range and timezone at the requested resolution.";
		case "network":
		case "timeout":
		case "server":
			return "OpenAnalytics is temporarily unavailable. Try again shortly.";
		default:
			return "OpenAnalytics could not load analytics. Revalidate the connection or try again shortly.";
	}
}

function errorCopy(error: unknown): string {
	return error instanceof OpenAnalyticsError
		? safeError(error.kind, error.retryAfterSeconds)
		: "OpenAnalytics is temporarily unavailable. Try again shortly.";
}

function waitingPage(
	selected: DateRange,
	apiUrl: string,
	trackingEnabled: boolean,
	message: string,
	needsValidation = true,
	notConfigured = false,
): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: "OpenAnalytics" },
			...connectionBlocks({
				apiUrl,
				trackingEnabled,
				needsValidation,
				notConfigured,
				error: needsValidation || notConfigured ? undefined : message,
			}),
			controls(selected, {
				validate: notConfigured || (needsValidation && message.startsWith("Validate")),
			}),
			...(needsValidation ? [{ type: "context" as const, text: message }] : []),
		],
	};
}

function timezoneFromSetting(value: unknown): { timezone: string; error: string | null } {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return { timezone: "UTC", error: null };
	try {
		new Intl.DateTimeFormat("en", { timeZone: raw }).format(0);
		return { timezone: raw, error: null };
	} catch {
		return {
			timezone: "UTC",
			error:
				"Analytics timezone is invalid. Set an IANA timezone such as America/New_York in plugin settings.",
		};
	}
}

async function loadAnalytics(
	config: OpenAnalyticsConfig,
	snapshot: SiteSnapshot,
	selected: DateRange,
	timezone: string,
	trackingEnabled: boolean,
): Promise<BlockResponse> {
	const site = safeConnectionSummary(snapshot.site);
	const bounds = queryFor(selected, timezone);
	const overviewQuery: AnalyticsReadQuery = { ...bounds, resolution: "hour", compare: true };
	const chartQuery: AnalyticsReadQuery = {
		...bounds,
		resolution: selected === "24h" ? "hour" : "day",
	};
	const reportQuery = { from: bounds.from, to: bounds.to, timezone, limit: 10 };
	const results = await Promise.allSettled([
		getOverview(config, overviewQuery),
		getTimeseries(config, chartQuery),
		getPages(config, reportQuery),
		getSources(config, reportQuery),
	]);
	const [overviewResult, chartResult, pagesResult, sourcesResult] = results;
	const overview = overviewResult.status === "fulfilled" ? overviewResult.value : undefined;
	const timeseries = chartResult.status === "fulfilled" ? chartResult.value : undefined;
	const pages = pagesResult.status === "fulfilled" ? pagesResult.value : undefined;
	const sources = sourcesResult.status === "fulfilled" ? sourcesResult.value : undefined;
	const failures = results.some((result) => result.status === "rejected");
	const blocks: Block[] = [
		{ type: "header", text: "OpenAnalytics" },
		...connectionBlocks({
			apiUrl: config.apiUrl,
			site,
			trackingEnabled,
			validatedAt: snapshot.validatedAt,
		}),
		controls(selected, { retry: failures }),
		{ type: "header", text: rangeLabel(selected) },
		...renderOverview({
			timezone,
			overview,
			timeseries,
			overviewError:
				overviewResult.status === "rejected" ? errorCopy(overviewResult.reason) : undefined,
			timeseriesError:
				chartResult.status === "rejected" ? errorCopy(chartResult.reason) : undefined,
		}),
		...renderPages(
			pages,
			pagesResult.status === "rejected" ? errorCopy(pagesResult.reason) : undefined,
		),
		...renderSources(
			sources,
			sourcesResult.status === "rejected" ? errorCopy(sourcesResult.reason) : undefined,
		),
	];
	return { blocks };
}

export async function renderAdminPage(ctx: RouteContext): Promise<BlockResponse> {
	const interaction = parseInput(ctx.input);
	if (!interaction)
		return {
			blocks: [
				{
					type: "banner",
					title: "Invalid request",
					description: "Reload this page and try again.",
					variant: "error",
				},
			],
		};
	if (
		interaction.type === "block_action" &&
		interaction.action_id === "range" &&
		(typeof interaction.value !== "string" || !RANGES.includes(interaction.value as DateRange))
	)
		return {
			blocks: [
				{ type: "header", text: "OpenAnalytics" },
				{
					type: "banner",
					title: "Invalid date range",
					description: "Choose one of the available ranges and try again.",
					variant: "error",
				},
			],
		};
	const selected = interaction.type === "block_action" ? selectedRange(interaction.value) : "30d";
	const [apiUrlValue, key, trackingValue, timezoneValue] = await Promise.all([
		ctx.settings.get<unknown>("apiUrl"),
		ctx.settings.get<unknown>("privateReadKey"),
		ctx.settings.get<unknown>("trackingEnabled"),
		ctx.settings.get<unknown>("timezone"),
	]);
	const trackingEnabled = trackingValue !== false;
	let config: OpenAnalyticsConfig;
	try {
		config = configurationFromSettings({ apiUrl: apiUrlValue, privateReadKey: key });
	} catch {
		const configured = typeof key === "string" && !!key.trim();
		return waitingPage(
			selected,
			displayApiUrl(apiUrlValue ?? DEFAULT_API_URL),
			trackingEnabled,
			configured
				? "The OpenAnalytics API URL or private read key is invalid. Review plugin settings."
				: "Add a private read key in plugin settings to connect OpenAnalytics.",
			true,
			!configured,
		);
	}
	const { timezone, error: timezoneError } = timezoneFromSetting(timezoneValue);
	let validationError: string | null = null;
	if (interaction.type === "block_action" && interaction.action_id === "revalidate") {
		const validation = await validateConnection(ctx);
		if (!validation.success) {
			validationError = safeError(
				validation.error.kind,
				"retryAfterSeconds" in validation.error ? validation.error.retryAfterSeconds : undefined,
			);
		}
	}
	const fingerprint = await configurationFingerprint(config.apiUrl, config.readKey);
	const snapshot = await ctx.kv.get<unknown>(SITE_SNAPSHOT_KEY);
	if (validationError) {
		if (isSiteSnapshot(snapshot) && snapshot.fingerprint === fingerprint) {
			return {
				blocks: [
					{ type: "header", text: "OpenAnalytics" },
					...connectionBlocks({
						apiUrl: config.apiUrl,
						site: safeConnectionSummary(snapshot.site),
						trackingEnabled,
						validatedAt: snapshot.validatedAt,
					}),
					controls(selected),
					{
						type: "banner",
						title: "Revalidation failed",
						description: validationError,
						variant: "error",
					},
				],
			};
		}
		return waitingPage(selected, config.apiUrl, trackingEnabled, validationError, false);
	}
	if (timezoneError) {
		return {
			blocks: [
				{ type: "header", text: "OpenAnalytics" },
				...(isSiteSnapshot(snapshot) && snapshot.fingerprint === fingerprint
					? connectionBlocks({
							apiUrl: config.apiUrl,
							site: safeConnectionSummary(snapshot.site),
							trackingEnabled,
							validatedAt: snapshot.validatedAt,
						})
					: connectionBlocks({ apiUrl: config.apiUrl, trackingEnabled, needsValidation: true })),
				controls(selected),
				{
					type: "banner",
					title: "Check analytics settings",
					description: timezoneError,
					variant: "error",
				},
			],
		};
	}
	if (!isSiteSnapshot(snapshot) || snapshot.fingerprint !== fingerprint) {
		return waitingPage(
			selected,
			config.apiUrl,
			trackingEnabled,
			isSiteSnapshot(snapshot)
				? "Configuration changed. Revalidate the connection to resume tracking and load analytics."
				: "Validate the connection to load analytics.",
		);
	}
	return loadAnalytics(config, snapshot, selected, timezone, trackingEnabled);
}
