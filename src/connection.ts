import { containsPrivateKey, isSiteReadContext } from "./openanalytics/client";
import { OpenAnalyticsError } from "./openanalytics/errors";
import type { SiteReadContext } from "./openanalytics/types";
import { parseConfiguration } from "./settings/config";

export const SITE_SNAPSHOT_KEY = "state:validated-site";

export interface SiteSnapshot {
	readonly version: 1;
	readonly fingerprint: string;
	readonly site: SiteReadContext;
}

/** Fingerprint the full credential pair without ever storing the credential. */
export async function configurationFingerprint(
	apiUrl: string,
	privateReadKey: string,
): Promise<string> {
	const input = new TextEncoder().encode(JSON.stringify([apiUrl, privateReadKey]));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function configurationFromSettings(settings: unknown) {
	const source =
		settings && typeof settings === "object" && !Array.isArray(settings)
			? (settings as Record<string, unknown>)
			: {};
	return parseConfiguration({
		apiUrl: source.apiUrl,
		readKey: source.privateReadKey,
	});
}

export function isSiteSnapshot(value: unknown): value is SiteSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const snapshot = value as Record<string, unknown>;
	if (
		snapshot.version !== 1 ||
		typeof snapshot.fingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(snapshot.fingerprint)
	)
		return false;
	return isSiteReadContext(snapshot.site) && !containsPrivateKey(snapshot.site);
}

function publicUrl(value: string | null): string | null {
	if (!value || containsPrivateKey(value)) return null;
	try {
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

/** The only installation values allowed into browser markup. */
export function usableInstallation(install: SiteReadContext["install"]) {
	const scriptUrl = publicUrl(install.script_url);
	const collectorUrl = publicUrl(install.collector_url);
	const trackingKey = install.tracking_key;
	if (!scriptUrl || !collectorUrl || !trackingKey || !/^oa_pk_[A-Za-z0-9_-]+$/.test(trackingKey))
		return null;
	return { scriptUrl, collectorUrl, trackingKey };
}

export function safeConnectionSummary(site: SiteReadContext) {
	return {
		siteId: site.site_id,
		slug: site.slug,
		name: site.name,
		status: site.status,
		install: {
			hasTrackingKey: !!site.install.tracking_key,
			scriptUrl: publicUrl(site.install.script_url),
			collectorUrl: publicUrl(site.install.collector_url),
			trackerReady: usableInstallation(site.install) !== null,
		},
	};
}

export function connectionError(error: unknown) {
	if (error instanceof OpenAnalyticsError) {
		return {
			kind: error.kind,
			message: error.message,
			...(error.status === undefined ? {} : { status: error.status }),
			...(error.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: error.retryAfterSeconds }),
		};
	}
	return {
		kind: "connection_failed",
		message: "Could not validate the OpenAnalytics connection.",
	};
}
