import type { Block } from "@emdash-cms/blocks";

import { containsPrivateKey } from "../openanalytics/client";
import { dateText, type DateRange } from "./ranges";

export function displayApiUrl(value: unknown): string {
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

export function connectionBlocks(args: {
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
					: args.site?.status === "suspended"
						? "Tracker installed · collection suspended"
						: "Tracker installed · collection unavailable";
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

export function controls(
	selected: DateRange,
	options: { validate?: boolean; retry?: boolean } = {},
): Block {
	const labels: Record<DateRange, string> = {
		"24h": "Last 24 hours",
		"7d": "Last 7 days",
		"30d": "Last 30 days",
		"90d": "Last 90 days",
	};
	const elements: Extract<Block, { type: "actions" }>["elements"] = [
		{
			type: "select",
			action_id: "range",
			label: "Date range",
			initial_value: selected,
			options: (["24h", "7d", "30d", "90d"] as const).map((value) => ({
				label: labels[value],
				value,
			})),
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
	return { type: "actions", elements };
}
