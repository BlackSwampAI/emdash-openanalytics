import type { PluginDescriptor } from "emdash";

export { createPlugin } from "./plugin";

/** Native EmDash plugin entry descriptor. */
export function openAnalytics(): PluginDescriptor {
	return {
		id: "openanalytics",
		version: "0.1.0",
		entrypoint: "@blackswampai/emdash-plugin-openanalytics",
		format: "native" as const,
	};
}
