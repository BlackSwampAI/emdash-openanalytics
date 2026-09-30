import { definePlugin } from "emdash";

import { renderAdminPage } from "./admin/page";
import { validateConnection } from "./connection";
import { settingsSchema } from "./settings/schema";
import { trackingFragment } from "./tracking/fragment";

export function createPlugin() {
	return definePlugin({
		id: "emdash-openanalytics",
		version: "0.1.0",
		capabilities: ["hooks.page-fragments:register"],
		admin: {
			settingsSchema,
			pages: [{ path: "/analytics", label: "OpenAnalytics", icon: "gauge" }],
		},
		routes: {
			admin: {
				methods: ["POST"],
				permission: "plugins:manage",
				request: { body: "json", maxBytes: 4_096 },
				handler: renderAdminPage,
			},
			"validate-connection": {
				methods: ["POST"],
				permission: "plugins:manage",
				handler: validateConnection,
			},
		},
		hooks: {
			"page:fragments": trackingFragment,
		},
	});
}
