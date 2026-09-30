import type { PageFragmentContribution, PageFragmentEvent, PluginContext } from "emdash";

import {
	configurationFingerprint,
	configurationFromSettings,
	isSiteSnapshot,
	SITE_SNAPSHOT_KEY,
	usableInstallation,
} from "../connection";
import type { OpenAnalyticsConfig } from "../settings/config";

export async function trackingFragment(
	event: PageFragmentEvent,
	ctx: PluginContext,
): Promise<PageFragmentContribution[]> {
	const pagePath = event.page.path;
	if (pagePath === "/_emdash" || pagePath.startsWith("/_emdash/")) return [];

	const [apiUrl, privateReadKey, trackingEnabled] = await Promise.all([
		ctx.settings.get<unknown>("apiUrl"),
		ctx.settings.get<unknown>("privateReadKey"),
		ctx.settings.get<unknown>("trackingEnabled"),
	]);
	if (trackingEnabled === false) return [];

	let config: OpenAnalyticsConfig;
	try {
		config = configurationFromSettings({
			apiUrl,
			privateReadKey,
		});
	} catch {
		return [];
	}
	const fingerprint = await configurationFingerprint(config.apiUrl, config.readKey);
	const snapshot = await ctx.kv.get<unknown>(SITE_SNAPSHOT_KEY);
	if (!isSiteSnapshot(snapshot) || snapshot.fingerprint !== fingerprint) return [];

	const install = usableInstallation(snapshot.site.install);
	if (!install) return [];
	return [
		{
			kind: "external-script",
			placement: "head",
			src: install.scriptUrl,
			async: true,
			key: "openanalytics-tracker",
			attributes: {
				"data-key": install.trackingKey,
				"data-collector": install.collectorUrl,
			},
		},
	];
}
