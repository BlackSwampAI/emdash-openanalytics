import type { AnalyticsReadQuery } from "../openanalytics/types";

export const RANGES = ["24h", "7d", "30d", "90d"] as const;
export type DateRange = (typeof RANGES)[number];

export function selectedRange(value: unknown): DateRange {
	if (typeof value === "string" && RANGES.includes(value as DateRange)) return value as DateRange;
	if (
		value &&
		typeof value === "object" &&
		"range" in value &&
		typeof value.range === "string" &&
		RANGES.includes(value.range as DateRange)
	)
		return value.range as DateRange;
	return "30d";
}

export function rangeLabel(selected: DateRange): string {
	return {
		"24h": "Last 24 hours",
		"7d": "Last 7 days",
		"30d": "Last 30 days",
		"90d": "Last 90 days",
	}[selected];
}

export function queryFor(
	selected: DateRange,
	timezone: string,
	now = Date.now(),
): AnalyticsReadQuery {
	const duration: Record<DateRange, number> = {
		"24h": 24 * 60 * 60 * 1000,
		"7d": 7 * 24 * 60 * 60 * 1000,
		"30d": 30 * 24 * 60 * 60 * 1000,
		"90d": 90 * 24 * 60 * 60 * 1000,
	};
	return {
		from: new Date(now - duration[selected]).toISOString(),
		to: new Date(now).toISOString(),
		timezone,
		resolution: selected === "24h" ? "hour" : "day",
	};
}

export function dateText(value: string | null, timezone: string): string | null {
	if (!value || !Number.isFinite(Date.parse(value))) return null;
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
		timeZone: timezone,
	}).format(new Date(value));
}

export function rangeText(value: { from: string; to: string }, timezone: string): string {
	const from = dateText(value.from, timezone);
	const to = dateText(value.to, timezone);
	return from && to ? `${from} – ${to}` : "unavailable";
}
