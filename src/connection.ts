import type { PluginContext } from "emdash";

import { containsPrivateKey, getSite, isSiteReadContext } from "./openanalytics/client";
import { OpenAnalyticsError } from "./openanalytics/errors";
import type { SiteReadContext } from "./openanalytics/types";
import { parseConfiguration } from "./settings/config";
import type { OpenAnalyticsConfig } from "./settings/config";

export const SITE_SNAPSHOT_KEY = "state:validated-site";

export interface SiteSnapshot {
	readonly version: 1;
	readonly fingerprint: string;
	readonly site: SiteReadContext;
	/** Optional for compatibility with scaffold snapshots created before PR #2. */
	readonly validatedAt?: string;
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

/** Validate the configured credentials server-side and refresh the public snapshot. */
export async function validateConnection(ctx: PluginContext) {
	let config: OpenAnalyticsConfig;
	try {
		const settings = {
			apiUrl: await ctx.settings.get<unknown>("apiUrl"),
			privateReadKey: await ctx.settings.get<unknown>("privateReadKey"),
		};
		config = configurationFromSettings(settings);
	} catch (error) {
		try {
			await ctx.kv.delete(SITE_SNAPSHOT_KEY);
		} catch {
			/* Never leak storage details to the admin response. */
		}
		return { success: false as const, error: connectionError(error) };
	}
	const fingerprint = await configurationFingerprint(config.apiUrl, config.readKey);
	try {
		const site = await getSite(config);
		const snapshot: SiteSnapshot = {
			version: 1,
			fingerprint,
			site,
			validatedAt: new Date().toISOString(),
		};
		await ctx.kv.set(SITE_SNAPSHOT_KEY, snapshot);
		return {
			success: true as const,
			site: safeConnectionSummary(site, config.apiUrl),
			validatedAt: snapshot.validatedAt,
		};
	} catch (error) {
		const existing = await ctx.kv.get<unknown>(SITE_SNAPSHOT_KEY).catch(() => undefined);
		const transient =
			error instanceof OpenAnalyticsError &&
			["network", "timeout", "rate_limited", "server"].includes(error.kind);
		const retainKnownGood =
			transient && isSiteSnapshot(existing) && existing.fingerprint === fingerprint;
		if (!retainKnownGood) {
			try {
				await ctx.kv.delete(SITE_SNAPSHOT_KEY);
			} catch {
				/* Never leak storage details to the admin response. */
			}
		}
		return { success: false as const, error: connectionError(error) };
	}
}

export function configurationFromSettings(settings: unknown) {
	const source =
		settings && typeof settings === "object" && !Array.isArray(settings)
			? (settings as Record<string, unknown>)
			: {};
	if (containsPrivateKey(source.apiUrl)) throw new OpenAnalyticsError("configuration");
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
		!/^[a-f0-9]{64}$/.test(snapshot.fingerprint) ||
		(snapshot.validatedAt !== undefined &&
			(typeof snapshot.validatedAt !== "string" ||
				!Number.isFinite(Date.parse(snapshot.validatedAt))))
	)
		return false;
	return isSiteReadContext(snapshot.site) && !containsPrivateKey(snapshot);
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

export function safeConnectionSummary(site: SiteReadContext, apiUrl?: string) {
	return {
		siteId: site.site_id,
		slug: site.slug,
		name: site.name,
		status: site.status,
		...(apiUrl && publicUrl(apiUrl) ? { apiUrl: publicUrl(apiUrl) } : {}),
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
