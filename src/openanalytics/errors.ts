export type OpenAnalyticsErrorKind =
	| "configuration"
	| "unauthorized"
	| "forbidden"
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
