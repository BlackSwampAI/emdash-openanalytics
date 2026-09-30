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
import { containsPrivateKey, getOverview, getTimeseries } from "../openanalytics/client";
import { OpenAnalyticsError } from "../openanalytics/errors";
import type {
	AnalyticsReadQuery,
	AnalyticsOverviewResponse,
	AnalyticsTimeseriesResponse,
} from "../openanalytics/types";
import { DEFAULT_API_URL, type OpenAnalyticsConfig } from "../settings/config";

const RANGES = ["24h", "7d", "30d", "90d"] as const;
type DateRange = (typeof RANGES)[number];
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

function range(value: unknown): DateRange {
	if (typeof value === "string" && RANGES.includes(value as DateRange)) return value as DateRange;
	if (record(value) && typeof value.range === "string" && RANGES.includes(value.range as DateRange))
		return value.range as DateRange;
	return "30d";
}

function displayApiUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "Not configured";
	if (containsPrivateKey(value)) return "Invalid API URL";
	try {
		const parsed = new URL(value.trim());
		if (
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			!["http:", "https:"].includes(parsed.protocol)
		)
			return "Invalid API URL";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return "Invalid API URL";
	}
}

function queryFor(selected: DateRange, tz: string, now = Date.now()): AnalyticsReadQuery {
	const ms: Record<DateRange, number> = {
		"24h": 24 * 60 * 60 * 1000,
		"7d": 7 * 24 * 60 * 60 * 1000,
		"30d": 30 * 24 * 60 * 60 * 1000,
		"90d": 90 * 24 * 60 * 60 * 1000,
	};
	return {
		from: new Date(now - ms[selected]).toISOString(),
		to: new Date(now).toISOString(),
		timezone: tz,
		resolution: selected === "24h" ? "hour" : "day",
	};
}

function label(selected: DateRange): string {
	return {
		"24h": "Last 24 hours",
		"7d": "Last 7 days",
		"30d": "Last 30 days",
		"90d": "Last 90 days",
	}[selected];
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

function dateText(value: string | null, tz: string): string | null {
	if (!value || !Number.isFinite(Date.parse(value))) return null;
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
		timeZone: tz,
	}).format(new Date(value));
}

function rangeText(value: { from: string; to: string }, tz: string): string {
	const from = dateText(value.from, tz);
	const to = dateText(value.to, tz);
	return from && to ? `${from} – ${to}` : "unavailable";
}

function connectionBlocks(args: {
	apiUrl: string;
	site?: {
		name: string;
		status: string;
		install: { hasTrackingKey: boolean; trackerReady: boolean };
	};
	trackingEnabled: boolean;
	validatedAt?: string;
	needsValidation?: boolean;
	notConfigured?: boolean;
	error?: string;
}): Block[] {
	let title = args.notConfigured
		? "Not configured"
		: args.needsValidation
			? "Needs validation"
			: "Connected";
	let description = args.notConfigured
		? "Add an OpenAnalytics private read key in plugin settings to connect this site."
		: args.needsValidation
			? "Validate your private read key to connect this EmDash site."
			: "Last validation confirmed this connection.";
	let variant: "default" | "alert" | "error" =
		args.notConfigured || args.needsValidation ? "alert" : "default";
	if (args.error) {
		title = "Connection needs attention";
		description = args.error;
		variant = "error";
	} else if (args.site && args.site.status !== "active") {
		title = `Connected · site ${args.site.status}`;
		description = "OpenAnalytics reports that this site is not active.";
		variant = "alert";
	}
	const install = args.site?.install;
	const tracking = !install?.hasTrackingKey
		? "No tracking key"
		: !install.trackerReady
			? "Tracking installation incomplete"
			: !args.trackingEnabled
				? "Tracking disabled"
				: args.site?.status === "active"
					? "Tracking active"
					: "Tracking inactive";
	return [
		{ type: "banner", title, description, variant },
		{
			type: "fields",
			fields: [
				{ label: "Site", value: args.site?.name ?? "—" },
				{ label: "Tracking", value: args.site ? tracking : "Not validated" },
				{ label: "API", value: args.apiUrl },
				{
					label: "Last validated",
					value: args.site
						? (dateText(args.validatedAt ?? null, "UTC") ?? "Not recorded")
						: "Never",
				},
			],
		},
	];
}

function controls(
	selected: DateRange,
	options: { validate?: boolean; retry?: boolean } = {},
): Block {
	const elements: Extract<Block, { type: "actions" }>["elements"] = [
		{
			type: "select",
			action_id: "range",
			label: "Date range",
			initial_value: selected,
			options: RANGES.map((value) => ({ label: label(value), value })),
		},
	];
	if (options.retry)
		elements.push({
			type: "button",
			action_id: "retry",
			label: "Retry analytics",
			style: "primary",
			value: { range: selected },
		});
	elements.push({
		type: "button",
		action_id: "revalidate",
		label: options.validate ? "Validate connection" : "Revalidate connection",
		style: "secondary",
		value: { range: selected },
	});
	return {
		type: "actions",
		elements,
	};
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

function getMetaWarning(
	response: AnalyticsOverviewResponse,
	timeseries: AnalyticsTimeseriesResponse,
): string | null {
	const metas = [response.meta, timeseries.meta];
	const unavailable = metas.some((meta) => meta.freshness === null);
	const delayed = metas.some(
		(meta) =>
			meta.freshness?.state === "stale" ||
			meta.freshness?.state === "degraded" ||
			meta.partial ||
			meta.truncated,
	);
	const imported = metas.some((meta) => meta.data_sources.includes("imported"));
	const estimated = metas.some((meta) => meta.accuracy !== "exact");
	if (metas.some((meta) => meta.freshness?.state === "no_data"))
		return "No analytics data is available for part or all of this range.";
	if (delayed && imported)
		return "Some imported data may be delayed or incomplete while OpenAnalytics finishes processing.";
	if (delayed)
		return "Results may be delayed or incomplete while OpenAnalytics finishes processing events.";
	if (imported && estimated)
		return "This range includes imported analytics. Some values are estimated or follow the import provider's definitions.";
	if (imported) return "This range includes imported analytics data.";
	if (estimated) return "OpenAnalytics marks some values as estimated or provider-defined.";
	if (unavailable) return "Freshness information is unavailable for part of this response.";
	return null;
}

async function loadAnalytics(
	config: OpenAnalyticsConfig,
	snapshot: SiteSnapshot,
	selected: DateRange,
	tz: string,
	trackingEnabled: boolean,
): Promise<BlockResponse> {
	const site = safeConnectionSummary(snapshot.site);
	const query = queryFor(selected, tz);
	const overviewQuery: AnalyticsReadQuery = { ...query, resolution: "hour", compare: true };
	let overview: AnalyticsOverviewResponse;
	let timeseries: AnalyticsTimeseriesResponse;
	try {
		[overview, timeseries] = await Promise.all([
			getOverview(config, overviewQuery),
			getTimeseries(config, query),
		]);
	} catch (error) {
		return {
			blocks: [
				{ type: "header", text: "OpenAnalytics" },
				...connectionBlocks({
					apiUrl: config.apiUrl,
					site,
					trackingEnabled,
					validatedAt: snapshot.validatedAt,
				}),
				controls(selected, { retry: true }),
				{
					type: "banner",
					title: "Analytics unavailable",
					description: errorCopy(error),
					variant: "error",
				},
			],
		};
	}
	const blocks: Block[] = [
		{ type: "header", text: "OpenAnalytics" },
		...connectionBlocks({
			apiUrl: config.apiUrl,
			site,
			trackingEnabled,
			validatedAt: snapshot.validatedAt,
		}),
		controls(selected),
		{ type: "header", text: label(selected) },
		{
			type: "context",
			text: `Buckets use ${tz}; chart timestamps are displayed in the browser timezone.`,
		},
		{
			type: "stats",
			items: (["visitors", "pageviews", "events"] as const).map((metric) => ({
				label: { visitors: "Visitors", pageviews: "Pageviews", events: "Events" }[metric],
				value: overview.totals[metric],
				...(overview.comparison
					? { description: `Previous period: ${overview.comparison.totals[metric]}` }
					: {}),
			})),
		},
		{
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "line",
				x_axis_name: "Time",
				y_axis_name: "Count",
				series: [
					{
						name: "Visitors",
						data: timeseries.series.map(
							(p) => [Date.parse(p.bucket), p.visitors] as [number, number],
						),
					},
					{
						name: "Pageviews",
						data: timeseries.series.map(
							(p) => [Date.parse(p.bucket), p.pageviews] as [number, number],
						),
					},
				],
			},
		},
	];
	const freshness = overview.meta.freshness;
	const watermark = freshness ? dateText(freshness.watermark, tz) : null;
	blocks.push({
		type: "context",
		text: watermark
			? `Latest rolled-up data: ${watermark}.`
			: "Latest rolled-up data timestamp is unavailable.",
	});
	blocks.push({
		type: "context",
		text: `Totals cover ${rangeText(overview.meta.effective_range, tz)}. Chart covers ${rangeText(timeseries.meta.effective_range, tz)}.`,
	});
	if (overview.comparison && overview.meta.comparison_range) {
		blocks.push({
			type: "context",
			text: `Previous period: ${rangeText(overview.meta.comparison_range, tz)}.`,
		});
	}
	if (overview.meta.freshness && timeseries.meta.freshness) {
		const states = {
			ok: "current",
			no_data: "no data",
			stale: "delayed",
			degraded: "status unavailable",
		};
		blocks.push({
			type: "context",
			text: `Data status: totals ${states[overview.meta.freshness.state]}; chart ${states[timeseries.meta.freshness.state]}.`,
		});
	}
	const warning = getMetaWarning(overview, timeseries);
	if (warning)
		blocks.push({ type: "banner", title: "Data status", description: warning, variant: "alert" });
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
	) {
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
	}
	const selected = interaction.type === "block_action" ? range(interaction.value) : "30d";
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
	const rawTimezone = typeof timezoneValue === "string" ? timezoneValue.trim() : "";
	let tz = "UTC";
	let timezoneError: string | null = null;
	if (rawTimezone) {
		try {
			new Intl.DateTimeFormat("en", { timeZone: rawTimezone }).format(0);
			tz = rawTimezone;
		} catch {
			timezoneError =
				"Analytics timezone is invalid. Set an IANA timezone such as America/New_York in plugin settings.";
		}
	}
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
			const site = safeConnectionSummary(snapshot.site);
			return {
				blocks: [
					{ type: "header", text: "OpenAnalytics" },
					...connectionBlocks({
						apiUrl: config.apiUrl,
						site,
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
		const blocks: Block[] = [
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
		];
		return { blocks };
	}
	if (!isSiteSnapshot(snapshot) || snapshot.fingerprint !== fingerprint) {
		const stale = isSiteSnapshot(snapshot);
		return waitingPage(
			selected,
			config.apiUrl,
			trackingEnabled,
			stale
				? "Configuration changed. Revalidate the connection to resume tracking and load analytics."
				: "Validate the connection to load analytics.",
		);
	}
	return loadAnalytics(config, snapshot, selected, tz, trackingEnabled);
}
