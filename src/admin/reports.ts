import type { Block } from "@emdash-cms/blocks";

import type { AnalyticsPagesResponse, AnalyticsSourcesResponse } from "../openanalytics/types";

function reportWarning(meta: AnalyticsPagesResponse["meta"]): string | null {
	const notices: string[] = [];
	if (meta.freshness?.state === "stale" || meta.freshness?.state === "degraded")
		notices.push("data may be delayed");
	if (meta.partial || meta.truncated) notices.push("results may be incomplete");
	if (meta.data_sources.includes("imported")) notices.push("includes imported data");
	if (meta.accuracy !== "exact") notices.push("some values are estimated or provider-defined");
	if (meta.freshness === null) notices.push("freshness information is unavailable");
	return notices.length ? `Report status: ${notices.join("; ")}.` : null;
}

export function renderPages(response?: AnalyticsPagesResponse, error?: string): Block[] {
	const blocks: Block[] = [{ type: "header", text: "Top Pages" }];
	if (error) {
		blocks.push({ type: "context", text: `Top pages temporarily unavailable. ${error}` });
		return blocks;
	}
	if (!response) return blocks;
	blocks.push({
		type: "table",
		page_action_id: "unused-pages-pagination",
		empty_text: "No page activity in this range.",
		columns: [
			{ key: "page", label: "Page", format: "code" },
			{ key: "views", label: "Views", format: "number" },
			{ key: "visitors", label: "Visitors", format: "number" },
		],
		rows: response.items.map((row) => ({
			page: row.page_path,
			views: row.views,
			visitors: row.visitors,
		})),
	});
	const warning = reportWarning(response.meta);
	if (warning) blocks.push({ type: "context", text: warning });
	return blocks;
}

function sourceLabel(row: AnalyticsSourcesResponse["items"][number]): string {
	const hasUtm = row.utm_source !== "" || row.utm_medium !== "" || row.utm_campaign !== "";
	const primary =
		row.referrer_domain || row.utm_source || (hasUtm ? "No referrer" : "Direct / internal");
	const dimensions = [
		row.utm_source && row.utm_source !== primary ? `source: ${row.utm_source}` : "",
		row.utm_medium ? `medium: ${row.utm_medium}` : "",
		row.utm_campaign ? `campaign: ${row.utm_campaign}` : "",
	].filter(Boolean);
	return dimensions.length ? `${primary} · ${dimensions.join(" · ")}` : primary;
}

export function renderSources(response?: AnalyticsSourcesResponse, error?: string): Block[] {
	const blocks: Block[] = [{ type: "header", text: "Traffic Sources" }];
	if (error) {
		blocks.push({ type: "context", text: `Traffic sources temporarily unavailable. ${error}` });
		return blocks;
	}
	if (!response) return blocks;
	blocks.push({
		type: "table",
		page_action_id: "unused-sources-pagination",
		empty_text: "No traffic sources recorded in this range.",
		columns: [
			{ key: "source", label: "Source", format: "text" },
			{ key: "views", label: "Views", format: "number" },
			{ key: "visitors", label: "Visitors", format: "number" },
		],
		rows: response.items.map((row) => ({
			source: sourceLabel(row),
			views: row.views,
			visitors: row.visitors,
		})),
	});
	const warning = reportWarning(response.meta);
	if (warning) blocks.push({ type: "context", text: warning });
	return blocks;
}
