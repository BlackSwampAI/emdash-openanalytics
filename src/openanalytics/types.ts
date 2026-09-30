/** The stable fields needed from GET /v1/read/site; additive fields are ignored. */
export interface SiteReadContext {
	readonly site_id: string;
	readonly slug: string;
	readonly name: string;
	readonly status: "active" | "suspended" | "deleting" | "deleted";
	readonly install: {
		readonly tracking_key: string | null;
		readonly script_url: string | null;
		readonly collector_url: string | null;
	};
}

export type AnalyticsResolution = "minute" | "hour" | "day" | "week";
export type AnalyticsReadResolution = "hour" | "day";
export type AnalyticsFreshnessState = "ok" | "no_data" | "stale" | "degraded";
export type AnalyticsDataSource = "live" | "imported";
export type AnalyticsAccuracy = "exact" | "estimated" | "provider_defined";

export interface AnalyticsDateRange {
	readonly from: string;
	readonly to: string;
}

export interface AnalyticsReadQuery extends AnalyticsDateRange {
	readonly timezone: string;
	readonly resolution: AnalyticsReadResolution;
	readonly compare?: boolean;
}

export interface AnalyticsFreshness {
	readonly state: AnalyticsFreshnessState;
	readonly watermark: string | null;
	readonly as_of: string;
}

/** Private read responses include freshness; public share responses do not. */
export interface AnalyticsMeta {
	readonly requested_range: AnalyticsDateRange;
	readonly effective_range: AnalyticsDateRange;
	readonly timezone: string;
	readonly resolution: AnalyticsResolution;
	readonly data_sources: readonly AnalyticsDataSource[];
	readonly accuracy: AnalyticsAccuracy;
	readonly freshness: AnalyticsFreshness | null;
	readonly comparison_range: AnalyticsDateRange | null;
	readonly truncated: boolean;
	readonly cached: boolean;
	readonly partial: boolean;
}

export interface OverviewTotals {
	readonly events: number;
	readonly pageviews: number;
	readonly visitors: number;
	readonly billable_events: number;
}

export interface AnalyticsOverviewResponse {
	readonly meta: AnalyticsMeta;
	readonly totals: OverviewTotals;
	readonly comparison: { readonly totals: OverviewTotals } | null;
}

export interface TimeseriesPoint {
	readonly bucket: string;
	readonly events: number;
	readonly pageviews: number;
	readonly visitors: number;
}

export interface AnalyticsTimeseriesResponse {
	readonly meta: AnalyticsMeta;
	readonly series: readonly TimeseriesPoint[];
	readonly comparison: { readonly series: readonly TimeseriesPoint[] } | null;
}
