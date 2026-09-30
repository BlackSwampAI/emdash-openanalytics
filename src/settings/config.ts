import { OpenAnalyticsError } from "../openanalytics/errors";

/** Official hosted API origin. Self-hosted installs can override this. */
export const DEFAULT_API_URL = "https://api.getopen.so";
export const DEFAULT_API_TIMEOUT_MS = 5_000;

export interface OpenAnalyticsConfig {
	readonly apiUrl: string;
	readonly readKey: string;
	readonly timeoutMs: number;
}

export interface ConfigurationInput {
	readonly apiUrl?: unknown;
	readonly readKey?: unknown;
	readonly timeoutMs?: unknown;
}

/** Validate the API base URL without retaining userinfo or URL parameters. */
export function parseApiBaseUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics API URL is not configured.");
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics API URL is invalid.");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics API URL is invalid.");
	}
	return url.toString().replace(/\/$/, "");
}

/** Parse saved settings once at the application boundary. */
export function parseConfiguration(input: ConfigurationInput): OpenAnalyticsConfig {
	const apiUrl = parseApiBaseUrl(input.apiUrl ?? DEFAULT_API_URL);
	if (typeof input.readKey !== "string" || !input.readKey.trim()) {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics read key is not configured.");
	}
	const readKey = input.readKey.trim();
	if (!/^oa_sk_[A-Za-z0-9_-]+$/.test(readKey)) {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics read key is invalid.");
	}
	const timeoutMs = input.timeoutMs === undefined ? DEFAULT_API_TIMEOUT_MS : input.timeoutMs;
	if (
		typeof timeoutMs !== "number" ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 30_000
	) {
		throw new OpenAnalyticsError("configuration", "OpenAnalytics timeout setting is invalid.");
	}
	return Object.freeze({ apiUrl, readKey, timeoutMs });
}
