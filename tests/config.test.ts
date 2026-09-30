import { describe, expect, it } from "vitest";

import { OpenAnalyticsError } from "../src/openanalytics/errors";
import {
	DEFAULT_API_TIMEOUT_MS,
	DEFAULT_API_URL,
	parseApiBaseUrl,
	parseConfiguration,
} from "../src/settings/config";

const readKey = "oa_sk_abc123";

describe("OpenAnalytics configuration", () => {
	it("uses the official API and timeout defaults", () => {
		expect(parseConfiguration({ readKey })).toEqual({
			apiUrl: DEFAULT_API_URL,
			readKey,
			timeoutMs: DEFAULT_API_TIMEOUT_MS,
		});
	});

	it("accepts HTTP self-hosted URLs and API paths", () => {
		expect(parseApiBaseUrl("http://localhost:8787/openanalytics/")).toBe(
			"http://localhost:8787/openanalytics",
		);
	});

	it.each([
		"ftp://api.example.test",
		"https://user:password@api.example.test",
		"https://api.example.test?secret=1",
		"https://api.example.test#fragment",
		"not a URL",
		"",
	])("rejects unsafe or invalid API URLs (%s)", (apiUrl) => {
		expect(() => parseConfiguration({ apiUrl, readKey })).toThrowError(OpenAnalyticsError);
	});

	it("rejects missing or malformed keys without reflecting the value", () => {
		for (const invalid of [undefined, "", "oa_sk_secret with spaces"]) {
			try {
				parseConfiguration({ apiUrl: DEFAULT_API_URL, readKey: invalid });
				throw new Error("expected invalid configuration");
			} catch (error) {
				expect(error).toBeInstanceOf(OpenAnalyticsError);
				expect((error as Error).message).not.toContain("secret");
			}
		}
	});

	it("rejects invalid timeout values", () => {
		for (const timeoutMs of [0, -1, 30_001, Number.NaN, "5"]) {
			expect(() =>
				parseConfiguration({ apiUrl: DEFAULT_API_URL, readKey, timeoutMs }),
			).toThrowError(OpenAnalyticsError);
		}
	});
});
