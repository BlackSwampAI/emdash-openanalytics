import { definePlugin } from "emdash";

import {
	configurationFingerprint,
	configurationFromSettings,
	connectionError,
	SITE_SNAPSHOT_KEY,
	safeConnectionSummary,
} from "./connection";
import { getSite } from "./openanalytics/client";
import { settingsSchema } from "./settings/schema";
import { trackingFragment } from "./tracking/fragment";

export function createPlugin() {
	return definePlugin({
		id: "emdash-openanalytics",
		version: "0.1.0",
		capabilities: ["hooks.page-fragments:register"],
		admin: { settingsSchema },
		routes: {
			"validate-connection": {
				methods: ["POST"],
				permission: "plugins:manage",
				handler: async (ctx) => {
					try {
						const settings = {
							apiUrl: await ctx.settings.get<unknown>("apiUrl"),
							privateReadKey: await ctx.settings.get<unknown>("privateReadKey"),
						};
						const config = configurationFromSettings(settings);
						const site = await getSite(config);
						const snapshot = {
							version: 1 as const,
							fingerprint: await configurationFingerprint(config.apiUrl, config.readKey),
							site,
						};
						await ctx.kv.set(SITE_SNAPSHOT_KEY, snapshot);
						return { success: true, site: safeConnectionSummary(site) };
					} catch (error) {
						try {
							await ctx.kv.delete(SITE_SNAPSHOT_KEY);
						} catch {
							/* Never leak storage details to the admin response. */
						}
						return { success: false, error: connectionError(error) };
					}
				},
			},
		},
		hooks: {
			"page:fragments": trackingFragment,
		},
	});
}
