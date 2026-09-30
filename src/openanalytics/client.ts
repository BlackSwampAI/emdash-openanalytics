import { type OpenAnalyticsConfig, parseConfiguration } from "../settings/config";
import { errorForStatus, OpenAnalyticsError } from "./errors";
import type { SiteReadContext } from "./types";

const PRIVATE_KEY_VALUE = /oa_sk_[A-Za-z0-9_-]+/i;
const SITE_STATUSES = new Set(["active", "suspended", "deleting", "deleted"]);

export function containsPrivateKey(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value === "string") {
		let decoded = value;
		for (let i = 0; i < 3; i += 1) {
			if (PRIVATE_KEY_VALUE.test(decoded)) return true;
			try {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			} catch {
				break;
			}
		}
		return PRIVATE_KEY_VALUE.test(decoded);
	}
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	return Object.values(value as Record<string, unknown>).some((item) =>
		containsPrivateKey(item, seen),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

export function isSiteReadContext(value: unknown): value is SiteReadContext {
	if (!isRecord(value) || !isRecord(value.install)) return false;
	const install = value.install;
	return (
		typeof value.site_id === "string" &&
		value.site_id.length > 0 &&
		typeof value.slug === "string" &&
		typeof value.name === "string" &&
		typeof value.status === "string" &&
		SITE_STATUSES.has(value.status) &&
		nullableString(install.tracking_key) &&
		nullableString(install.script_url) &&
		nullableString(install.collector_url)
	);
}

/** Read the site context associated with a private read key. */
export async function getSite(config: OpenAnalyticsConfig): Promise<SiteReadContext> {
	const validated = parseConfiguration(config);
	const base = validated.apiUrl;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), validated.timeoutMs);
	try {
		const response = await fetch(`${base}/v1/read/site`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${validated.readKey}`,
				Accept: "application/json",
			},
			redirect: "error",
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) throw errorForStatus(response.status, response.headers.get("retry-after"));
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			if (controller.signal.aborted) throw new OpenAnalyticsError("timeout");
			throw new OpenAnalyticsError("invalid_response");
		}
		if (!isSiteReadContext(payload)) {
			throw new OpenAnalyticsError("invalid_response");
		}
		// Project known contract members; additive API fields never escape this boundary.
		const site = {
			site_id: payload.site_id,
			slug: payload.slug,
			name: payload.name,
			status: payload.status,
			install: Object.freeze({
				tracking_key: payload.install.tracking_key,
				script_url: payload.install.script_url,
				collector_url: payload.install.collector_url,
			}),
		};
		if (containsPrivateKey(site)) throw new OpenAnalyticsError("invalid_response");
		return Object.freeze(site);
	} catch (error) {
		if (error instanceof OpenAnalyticsError) throw error;
		if (controller.signal.aborted) throw new OpenAnalyticsError("timeout");
		throw new OpenAnalyticsError("network");
	} finally {
		clearTimeout(timeout);
	}
}
