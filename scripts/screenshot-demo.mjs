import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCREENSHOTS = join(ROOT, "docs/screenshots");
const usedPorts = new Set();
async function availablePort() {
	while (true) {
		const port = await new Promise((resolvePort, rejectPort) => {
			const socket = createServer();
			socket.once("error", rejectPort);
			socket.listen(0, "127.0.0.1", () => {
				const address = socket.address();
				if (!address || typeof address === "string")
					return rejectPort(new Error("Could not reserve a port"));
				socket.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
			});
		});
		if (usedPorts.has(port)) continue;
		usedPorts.add(port);
		return port;
	}
}
const OA_PORT = await availablePort();
const PORT = await availablePort();
const runId = randomUUID();
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_BASE = `http://127.0.0.1:${OA_PORT}`;
const SYNTHETIC_KEY = "oa_sk_demo_fixture_only_00000000000000000000000000000000";
const SECRET_PATTERN = /oa_sk_[a-zA-Z0-9_-]{12,}/g;
const staging = await mkdtemp(join(tmpdir(), "openanalytics-ui-shot-"));
const childLogs = [];
const responseText = [];
const children = [];
let browser;

function start(command, args, label, env = {}) {
	const child = spawn(command, args, {
		cwd: label === "emdash" ? join(ROOT, "demo") : ROOT,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	for (const stream of [child.stdout, child.stderr]) {
		let pending = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) childLogs.push(`[${label}] ${line}`);
		});
	}
	return child;
}

async function waitFor(url, child, label, matchRunId = false) {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null)
			throw new Error(
				`${label} exited (${child.exitCode}) before becoming ready.\n${childLogs.slice(-30).join("\n")}`,
			);
		let response;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(1500) });
		} catch {
			// The process has not bound its loopback port yet.
			await delay(250);
			continue;
		}
		if (!response.ok) {
			if (matchRunId && response.status === 404)
				throw new Error(`${label} readiness route was not found at ${url}.`);
			await delay(250);
			continue;
		}
		if (matchRunId) {
			const body = await response.json();
			if (body.run !== runId) throw new Error(`${label} readiness token did not match this run.`);
		}
		if (child.exitCode !== null) throw new Error(`${label} process exited after its health check.`);
		return;
	}
	throw new Error(`${label} did not become ready at ${url}.\n${childLogs.slice(-30).join("\n")}`);
}

async function requireOk(response, label) {
	const body = await response.text();
	responseText.push(`${label}: ${body}`);
	if (!response.ok()) throw new Error(`${label} failed (${response.status()})`);
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
}

function assertNoSecret(value, label) {
	const text = Buffer.isBuffer(value)
		? value.toString("latin1")
		: typeof value === "string"
			? value
			: JSON.stringify(value);
	const variants = Buffer.isBuffer(value)
		? [text, value.toString("utf8"), value.toString("base64")]
		: [text];
	try {
		variants.push(decodeURIComponent(text));
	} catch {
		/* Not percent encoded. */
	}
	try {
		variants.push(Buffer.from(text, "base64").toString("utf8"));
	} catch {
		/* Not base64. */
	}
	for (const candidate of variants) {
		if (SYNTHETIC_KEY && candidate.includes(SYNTHETIC_KEY))
			throw new Error(`Fixture credential appeared in ${label}`);
		if (SECRET_PATTERN.test(candidate)) throw new Error(`Credential-like value found in ${label}`);
		SECRET_PATTERN.lastIndex = 0;
	}
}

async function getSession(page) {
	await page.goto(`${BASE}/_emdash/api/setup/dev-bypass?redirect=/_emdash/api/auth/me`);
	await page.waitForURL((url) => url.pathname === "/_emdash/api/auth/me", { timeout: 30_000 });
	const dismissed = await page.request.post(`${BASE}/_emdash/api/auth/me`, {
		headers: { "X-EmDash-Request": "1" },
		data: { action: "dismissWelcome" },
	});
	if (!dismissed.ok())
		throw new Error(`Could not clear first-login welcome (${dismissed.status()})`);
}

async function waitForStableChart(page) {
	await page.waitForFunction(
		() => {
			const charts = [...document.querySelectorAll("canvas")].filter((canvas) => {
				const rect = canvas.getBoundingClientRect();
				return rect.width >= 400 && rect.height >= 150;
			});
			if (charts.length === 0) return false;
			let pixels;
			try {
				pixels = charts.map((canvas) => canvas.toDataURL()).join(":");
			} catch {
				return false;
			}
			const windowWithChartState = window;
			const state = windowWithChartState.oaChartCapture;
			if (!state || state.pixels !== pixels) {
				windowWithChartState.oaChartCapture = { pixels, stableFrames: 0 };
				return false;
			}
			state.stableFrames += 1;
			return state.stableFrames >= 90;
		},
		undefined,
		{ timeout: 30_000, polling: "raf" },
	);
}

try {
	if (new URL(BASE).hostname !== "127.0.0.1" || new URL(FIXTURE_BASE).hostname !== "127.0.0.1")
		throw new Error("The screenshot demo must bind to loopback only.");
	start(process.execPath, [join(ROOT, "scripts/demo-openanalytics.mjs")], "oa-fixture", {
		OA_FIXTURE_PORT: String(OA_PORT),
		OA_FIXTURE_RUN_ID: runId,
	});
	await waitFor(
		`${FIXTURE_BASE}/__health?run=${runId}`,
		children[0],
		"OpenAnalytics fixture",
		true,
	);
	start(
		join(ROOT, "node_modules/.bin/astro"),
		["dev", "--no-background", "--host", "127.0.0.1", "--port", String(PORT)],
		"emdash",
		{
			HOST: "127.0.0.1",
			TZ: "America/New_York",
			EMDASH_DEMO_DB_URL: `file:${join(staging, "demo.db")}`,
			EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			ASTRO_DEV_BACKGROUND: "1",
			EMDASH_DEMO_PORT: String(PORT),
			EMDASH_DEMO_RUN_ID: runId,
		},
	);
	await waitFor(`${BASE}/demo-health?run=${runId}`, children[1], "EmDash", true);

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1100 },
		deviceScaleFactor: 1,
	});
	const page = await context.newPage();
	const responseScans = [];
	page.on("response", (response) => {
		if (!response.url().startsWith(BASE)) return;
		responseScans.push(
			(async () => {
				try {
					const type = response.headers()["content-type"] ?? "";
					if (!/(json|text|javascript|xml|svg)/i.test(type)) return;
					responseText.push(`${response.url()}: ${await response.text()}`);
				} catch {
					/* Request was cancelled or returned a non-text body. */
				}
			})(),
		);
	});
	await getSession(page);
	const headers = { "X-EmDash-Request": "1", "Content-Type": "application/json", Origin: BASE };
	const settings = await page.request.put(
		`${BASE}/_emdash/api/admin/plugins/emdash-openanalytics/settings`,
		{
			headers,
			data: {
				values: {
					apiUrl: FIXTURE_BASE,
					privateReadKey: SYNTHETIC_KEY,
					trackingEnabled: true,
					timezone: "America/New_York",
				},
			},
		},
	);
	await requireOk(settings, "seed synthetic plugin settings");
	const validation = await page.request.post(
		`${BASE}/_emdash/api/plugins/emdash-openanalytics/validate-connection`,
		{
			headers,
			data: {},
		},
	);
	const validationJson = await requireOk(validation, "validate fixture connection");
	const validationResult = validationJson.data ?? validationJson;
	if (validationResult.success !== true)
		throw new Error("The fixture connection did not validate successfully.");

	const requested = [];
	page.on("request", (request) => {
		if (request.url().includes("/_emdash/api/plugins/emdash-openanalytics"))
			requested.push(request.url());
	});
	await page.goto(`${BASE}/_emdash/admin/plugins/emdash-openanalytics/analytics`);
	await page.locator("text=Top Pages").waitFor({ state: "visible", timeout: 30_000 });
	await page.locator("text=Traffic Sources").waitFor({ state: "visible", timeout: 30_000 });
	await page.getByText("1284", { exact: true }).waitFor({ state: "visible" });
	await page.getByText("EmDash Demo", { exact: true }).waitFor({ state: "visible" });
	await page.locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 });
	await waitForStableChart(page);
	await Promise.all(responseScans);

	// Inspect exactly the rendered page contents and all returned text before any PNG is retained.
	const desktopText = await page.locator("body").innerText();
	const desktopHtml = await page.content();
	assertNoSecret(desktopText, "desktop rendered text");
	assertNoSecret(desktopHtml, "desktop page HTML");
	for (const item of responseText) assertNoSecret(item, "browser HTML/API response body");
	for (const line of childLogs) assertNoSecret(line, "demo process logs");
	const readLogResponse = await fetch(`${FIXTURE_BASE}/__requests`);
	const readLog = await readLogResponse.json();
	const analyticsReads = readLog.filter((item) => item.path.startsWith("/v1/read/analytics/"));
	const relevant = [
		"/v1/read/analytics/overview",
		"/v1/read/analytics/timeseries",
		"/v1/read/analytics/pages",
		"/v1/read/analytics/sources",
	];
	for (const path of relevant) {
		const entry = analyticsReads.find((item) => item.path === path);
		if (!entry || !entry.from || !entry.to || entry.timezone !== "America/New_York")
			throw new Error(`Expected range and timezone were not sent to ${path}.`);
		if (path.endsWith("/pages") || path.endsWith("/sources")) {
			if (entry.limit !== "10") throw new Error(`Expected fixed limit=10 on ${path}.`);
		}
	}
	if (new Set(analyticsReads.map(({ from, to }) => `${from}|${to}`)).size !== 1)
		throw new Error("Overview and report calls did not share one selected range.");
	await mkdir(staging, { recursive: true });
	await waitForStableChart(page);
	await page.screenshot({ path: join(staging, "openanalytics-overview.png"), fullPage: false });
	await page.getByText("Top Pages", { exact: true }).scrollIntoViewIfNeeded();
	await waitForStableChart(page);
	await page.screenshot({ path: join(staging, "openanalytics-reports.png"), fullPage: false });

	await page.setViewportSize({ width: 640, height: 1800 });
	await page.evaluate(() => {
		delete window.oaChartCapture;
		window.scrollTo(0, 0);
		for (const element of document.querySelectorAll("*")) {
			const style = getComputedStyle(element);
			if (
				element.scrollHeight > element.clientHeight &&
				(style.overflowY === "auto" || style.overflowY === "scroll")
			)
				element.scrollTop = 0;
		}
	});
	await page.getByRole("heading", { name: "OpenAnalytics" }).waitFor({ state: "visible" });
	await waitForStableChart(page);
	await Promise.all(responseScans);
	const narrowText = await page.locator("body").innerText();
	const narrowHtml = await page.content();
	assertNoSecret(narrowText, "narrow rendered text");
	assertNoSecret(narrowHtml, "narrow page HTML");
	await page.screenshot({ path: join(staging, "openanalytics-narrow.png"), fullPage: false });
	assertNoSecret(
		await readFile(join(staging, "openanalytics-overview.png")),
		"overview screenshot bytes",
	);
	assertNoSecret(
		await readFile(join(staging, "openanalytics-reports.png")),
		"reports screenshot bytes",
	);
	assertNoSecret(
		await readFile(join(staging, "openanalytics-narrow.png")),
		"narrow screenshot bytes",
	);
	if (requested.length === 0)
		throw new Error("The actual plugin admin route did not make an analytics request.");
	await mkdir(SCREENSHOTS, { recursive: true });
	for (const name of [
		"openanalytics-overview.png",
		"openanalytics-reports.png",
		"openanalytics-narrow.png",
	])
		await writeFile(join(SCREENSHOTS, name), await readFile(join(staging, name)));
	console.log(`Screenshots saved to ${SCREENSHOTS}`);
} catch (error) {
	if (error instanceof Error) {
		error.message = error.message.replace(SECRET_PATTERN, "[REDACTED]");
		if (error.stack) error.stack = error.stack.replace(SECRET_PATTERN, "[REDACTED]");
		// Keep upstream response bodies out of surfaced error causes.
		// oxlint-disable-next-line preserve-caught-error -- Raw errors may contain credentials.
		throw new Error(error.message);
	}
	// oxlint-disable-next-line preserve-caught-error -- Raw values may contain credentials.
	throw new Error("Unknown screenshot failure");
} finally {
	if (browser) await browser.close().catch(() => {});
	for (const child of children) child.kill("SIGTERM");
	await Promise.all(
		children.map(
			(child) =>
				new Promise((resolveDone) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolveDone();
					child.once("exit", resolveDone);
					setTimeout(() => {
						child.kill("SIGKILL");
						resolveDone();
					}, 3000).unref();
				}),
		),
	);
	await rm(staging, { recursive: true, force: true });
}
