export type OpenAnalyticsErrorKind =
	| "configuration"
	| "unauthorized"
	| "forbidden"
	| "analytics_forbidden"
	| "suspended"
	| "range_invalid"
	| "resolution_unavailable"
	| "billing"
	| "not_found"
	| "rate_limited"
	| "server"
	| "network"
	| "timeout"
	| "invalid_response";

const MESSAGES: Record<OpenAnalyticsErrorKind, string> = {
	configuration: "OpenAnalytics configuration is invalid.",
	unauthorized: "OpenAnalytics rejected the read key. Check that it is current and valid.",
	forbidden: "This OpenAnalytics read key does not have permission to read site details.",
	analytics_forbidden: "This OpenAnalytics read key does not have analytics:read permission.",
	suspended:
		"OpenAnalytics analytics are unavailable because this site is suspended. Check its OpenAnalytics account status.",
	range_invalid: "OpenAnalytics could not read analytics for this date range.",
	resolution_unavailable:
		"OpenAnalytics cannot provide this chart resolution for the selected range and timezone.",
	billing: "OpenAnalytics site access is paused because of a billing issue.",
	not_found: "The OpenAnalytics site for this read key was not found.",
	rate_limited: "OpenAnalytics is receiving too many requests. Try again shortly.",
	server: "OpenAnalytics is temporarily unavailable. Try again shortly.",
	network: "Could not connect to OpenAnalytics.",
	timeout: "OpenAnalytics did not respond in time.",
	invalid_response: "OpenAnalytics returned an invalid response.",
};

/** Safe, fixed-message error. Never attach response bodies, URLs, or credentials. */
export class OpenAnalyticsError extends Error {
	readonly kind: OpenAnalyticsErrorKind;
	readonly status?: number;
	readonly retryAfterSeconds?: number;

	constructor(
		kind: OpenAnalyticsErrorKind,
		message?: string,
		status?: number,
		retryAfterSeconds?: number,
	) {
		super(message ?? MESSAGES[kind]);
		this.name = "OpenAnalyticsError";
		this.kind = kind;
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

function upstreamErrorCode(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const error = (payload as Record<string, unknown>).error;
	if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
	const code = (error as Record<string, unknown>).code;
	return typeof code === "string" ? code : undefined;
}

/** Map only stable, documented upstream codes; never expose upstream messages. */
export function analyticsErrorForStatus(
	status: number,
	retryAfterHeader?: string | null,
	payload?: unknown,
): OpenAnalyticsError {
	const code = upstreamErrorCode(payload);
	if (status === 403) {
		if (code === "SITE_SUSPENDED") return new OpenAnalyticsError("suspended", undefined, status);
		return new OpenAnalyticsError("analytics_forbidden", undefined, status);
	}
	if (status === 400) {
		if (code === "RESOLUTION_NOT_AVAILABLE") {
			return new OpenAnalyticsError("resolution_unavailable", undefined, status);
		}
		if (code === "VALIDATION_FAILED" || code === "RANGE_TOO_LARGE") {
			return new OpenAnalyticsError("range_invalid", undefined, status);
		}
	}
	return errorForStatus(status, retryAfterHeader);
}

export function errorForStatus(
	status: number,
	retryAfterHeader?: string | null,
): OpenAnalyticsError {
	switch (status) {
		case 401:
			return new OpenAnalyticsError("unauthorized", undefined, status);
		case 403:
			return new OpenAnalyticsError("forbidden", undefined, status);
		case 402:
			return new OpenAnalyticsError("billing", undefined, status);
		case 404:
			return new OpenAnalyticsError("not_found", undefined, status);
		case 429: {
			const seconds =
				retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())
					? Number(retryAfterHeader.trim())
					: undefined;
			return new OpenAnalyticsError(
				"rate_limited",
				undefined,
				status,
				seconds !== undefined && Number.isSafeInteger(seconds) ? seconds : undefined,
			);
		}
		default:
			return new OpenAnalyticsError("server", undefined, status);
	}
}
