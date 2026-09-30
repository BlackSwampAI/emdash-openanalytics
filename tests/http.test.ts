import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getSite } from "../src/openanalytics/client";
import { OpenAnalyticsError } from "../src/openanalytics/errors";
import { parseConfiguration } from "../src/settings/config";

const readKey = "oa_sk_http_fixture_secret";
const site = {
	site_id: "01J0SITE000000000000000000",
	slug: "self-hosted",
	name: "Self-hosted site",
	status: "active",
	install: {
		tracking_key: "oa_pk_fixture",
		script_url: "https://assets.example.test/custom-tracker.js",
		collector_url: "https://events.example.test/collect",
	},
};

let server: Server;
let baseUrl: string;
let requestPath = "";
let authorization = "";
let redirectedRequestCount = 0;
let slowResponse = false;
let redirectToFixture = false;

function sendJson(response: ServerResponse, value: unknown) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

async function route(request: IncomingMessage, response: ServerResponse) {
	requestPath = request.url ?? "";
	authorization = request.headers.authorization ?? "";

	if (request.url === "/redirect-target") {
		redirectedRequestCount += 1;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(site));
		return;
	}

	if (request.url !== "/api-root/v1/read/site") {
		response.writeHead(404);
		response.end();
		return;
	}

	if (slowResponse) {
		response.writeHead(200, { "content-type": "application/json" });
		response.flushHeaders();
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (!response.destroyed) response.end(JSON.stringify(site));
		return;
	}

	if (redirectToFixture) {
		response.writeHead(302, { location: "/redirect-target" });
		response.end();
		return;
	}

	sendJson(response, site);
}

beforeAll(async () => {
	server = createServer((request, response) => {
		void route(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP fixture failed to bind");
	baseUrl = `http://127.0.0.1:${address.port}/api-root`;
});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

describe("getSite HTTP transport", () => {
	it("requests the site below an API path prefix and preserves custom install URLs", async () => {
		slowResponse = false;
		const result = await getSite(parseConfiguration({ apiUrl: baseUrl, readKey }));
		expect(requestPath).toBe("/api-root/v1/read/site");
		expect(authorization).toBe(`Bearer ${readKey}`);
		expect(result).toEqual(site);
	});

	it("rejects a redirect without forwarding the read key", async () => {
		redirectedRequestCount = 0;
		redirectToFixture = true;
		try {
			await expect(getSite(parseConfiguration({ apiUrl: baseUrl, readKey }))).rejects.toMatchObject(
				{ kind: "network" },
			);
			expect(redirectedRequestCount).toBe(0);
		} finally {
			redirectToFixture = false;
		}
	});

	it("times out while waiting for the real HTTP response body", async () => {
		slowResponse = true;
		try {
			try {
				await getSite(parseConfiguration({ apiUrl: baseUrl, readKey, timeoutMs: 20 }));
				throw new Error("expected request to time out");
			} catch (error) {
				expect(error).toBeInstanceOf(OpenAnalyticsError);
				expect(error).toMatchObject({ kind: "timeout" });
			}
		} finally {
			slowResponse = false;
		}
	});
});
