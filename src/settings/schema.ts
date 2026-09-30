import type { SettingField } from "emdash";

import { DEFAULT_API_URL } from "./config";

/** Settings surfaced through EmDash's native plugin settings page. */
export const settingsSchema = {
	apiUrl: {
		type: "url",
		label: "OpenAnalytics API URL",
		description: "API origin for your OpenAnalytics account.",
		default: DEFAULT_API_URL,
	},
	privateReadKey: {
		type: "secret",
		label: "Private read key",
		description: "Read-only key used to validate and load your site installation.",
	},
	trackingEnabled: {
		type: "boolean",
		label: "Enable tracking",
		description: "Load the OpenAnalytics tracking script on public pages.",
		default: true,
	},
} satisfies Record<string, SettingField>;
