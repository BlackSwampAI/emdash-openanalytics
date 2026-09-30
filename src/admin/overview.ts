import type { Block } from "@emdash-cms/blocks";

import type {
	AnalyticsOverviewResponse,
	AnalyticsTimeseriesResponse,
} from "../openanalytics/types";
import { dateText, rangeText } from "./ranges";

const STATUS = {
	ok: "current",
	no_data: "no data",
	stale: "delayed",
	degraded: "status unavailable",
} as const;

export function renderOverview(args: {
	timezone: string;
	overview?: AnalyticsOverviewResponse;
	timeseries?: AnalyticsTimeseriesResponse;
	overviewError?: string;
	timeseriesError?: string;
}): Block[] {
	const blocks: Block[] = [];
	if (args.overview) {
		const overview = args.overview;
		blocks.push({
			type: "stats",
			items: (["visitors", "pageviews", "events"] as const).map((metric) => ({
				label: { visitors: "Visitors", pageviews: "Pageviews", events: "Events" }[metric],
				value: overview.totals[metric],
				...(overview.comparison
					? { description: `Previous period: ${overview.comparison.totals[metric]}` }
					: {}),
			})),
		});
		const freshness = args.overview.meta.freshness;
		const watermark = freshness ? dateText(freshness.watermark, args.timezone) : null;
		blocks.push({
			type: "context",
			text: watermark
				? `Latest rolled-up data: ${watermark}.`
				: "Latest rolled-up data timestamp is unavailable.",
		});
		blocks.push({
			type: "context",
			text: `Totals cover ${rangeText(args.overview.meta.effective_range, args.timezone)}.`,
		});
		if (args.overview.comparison && args.overview.meta.comparison_range) {
			blocks.push({
				type: "context",
				text: `Previous period: ${rangeText(args.overview.meta.comparison_range, args.timezone)}.`,
			});
		}
		if (freshness)
			blocks.push({ type: "context", text: `Data status: totals ${STATUS[freshness.state]}.` });
		const warning = metaWarning(args.overview.meta);
		if (warning)
			blocks.push({
				type: "banner",
				title: "Overview data status",
				description: warning,
				variant: "alert",
			});
	} else if (args.overviewError) {
		blocks.push({
			type: "banner",
			title: "Overview unavailable",
			description: args.overviewError,
			variant: "error",
		});
	}

	if (args.timeseries) {
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "line",
				x_axis_name: "Time",
				y_axis_name: "Count",
				series: [
					{
						name: "Visitors",
						data: args.timeseries.series.map((p) => [Date.parse(p.bucket), p.visitors]),
					},
					{
						name: "Pageviews",
						data: args.timeseries.series.map((p) => [Date.parse(p.bucket), p.pageviews]),
					},
				],
			},
		});
		blocks.push({
			type: "context",
			text: `Chart covers ${rangeText(args.timeseries.meta.effective_range, args.timezone)}. Buckets use ${args.timezone}; timestamps are displayed in the browser timezone.`,
		});
		if (args.timeseries.meta.freshness)
			blocks.push({
				type: "context",
				text: `Data status: chart ${STATUS[args.timeseries.meta.freshness.state]}.`,
			});
		const warning = metaWarning(args.timeseries.meta);
		if (warning)
			blocks.push({
				type: "banner",
				title: "Chart data status",
				description: warning,
				variant: "alert",
			});
	} else if (args.timeseriesError) {
		blocks.push({
			type: "banner",
			title: "Chart unavailable",
			description: args.timeseriesError,
			variant: "error",
		});
	}
	return blocks;
}

function metaWarning(meta: AnalyticsOverviewResponse["meta"]): string | null {
	if (meta.freshness?.state === "no_data")
		return "No analytics data is available for part or all of this range.";
	const delayed =
		meta.freshness?.state === "stale" ||
		meta.freshness?.state === "degraded" ||
		meta.partial ||
		meta.truncated;
	const imported = meta.data_sources.includes("imported");
	const estimated = meta.accuracy !== "exact";
	if (delayed && imported)
		return "Some imported data may be delayed or incomplete while OpenAnalytics finishes processing.";
	if (delayed)
		return "Results may be delayed or incomplete while OpenAnalytics finishes processing events.";
	if (imported && estimated)
		return "This range includes imported analytics. Some values are estimated or follow the import provider's definitions.";
	if (imported) return "This range includes imported analytics data.";
	if (estimated) return "OpenAnalytics marks some values as estimated or provider-defined.";
	if (meta.freshness === null) return "Freshness information is unavailable for this response.";
	return null;
}
