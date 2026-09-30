import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDialect as createSqliteDialect } from "emdash/db/sqlite";
import {
	EmDashRuntime,
	dispatchPluginApiRequest,
	handlePluginSettingsGet,
	handlePluginSettingsUpdate,
	type RuntimeDependencies,
} from "emdash/internal/plugin-test-runtime";
import { renderFragments } from "emdash/page";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlugin } from "../src/plugin";

const runtimes: EmDashRuntime[] = [];
const PRIVATE_KEY = "oa_sk_test-credential-must-stay-server-side";
const ENCRYPTION_KEY = `emdash_enc_v1_${Buffer.alloc(32, 11).toString("base64url")}`;

async function makeRuntime() {
	const directory = mkdtempSync(join(tmpdir(), "openanalytics-test-"));
	const databasePath = join(directory, "test.sqlite");
	const dependencies = {
		config: {
			database: {
				entrypoint: "openanalytics-test",
				config: { url: `file:${databasePath}` },
				type: "sqlite",
			},
		},
		plugins: [createPlugin()],
		createDialect: (config) => createSqliteDialect(config),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	} as RuntimeDependencies;
	const runtime = await EmDashRuntime.create(dependencies);
	runtimes.push(runtime);
	(runtime as EmDashRuntime & { testDirectory: string }).testDirectory = directory;
	return runtime;
}

async function validateConnection(
	runtime: EmDashRuntime,
	pluginId: string,
	options: { role?: number; skipScopes?: boolean } = {},
) {
	return dispatchPluginApiRequest({
		runtime,
		pluginId,
		path: "/validate-connection",
		request: new Request(`https://cms.test/_emdash/api/plugins/${pluginId}/validate-connection`, {
			method: "POST",
		}),
		...(options.role === undefined
			? {}
			: {
					user: {
						id: `user-${options.role}`,
						email: "user@example.test",
						name: "Test user",
						role: options.role,
						createdAt: new Date().toISOString(),
					},
				}),
		...(options.skipScopes ? {} : { tokenScopes: ["admin"] }),
	});
}

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await Promise.all(
		runtimes.splice(0).map(async (runtime) => {
			await runtime.shutdown();
			rmSync((runtime as EmDashRuntime & { testDirectory: string }).testDirectory, {
				recursive: true,
				force: true,
			});
		}),
	);
});

describe("OpenAnalytics native EmDash runtime", () => {
	it("fails closed when EmDash has no plugin secret encryption key", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "");
		const runtime = await makeRuntime();
		const plugin = runtime.configuredPlugins.find(({ id }) => id === "openanalytics");
		if (!plugin?.admin?.settingsSchema)
			throw new Error("OpenAnalytics settings schema was not registered");

		const update = await handlePluginSettingsUpdate(
			runtime.db,
			plugin.id,
			plugin.admin.settingsSchema,
			{
				trackingEnabled: false,
				privateReadKey: PRIVATE_KEY,
			},
		);
		expect(update.success).toBe(false);
		expect(JSON.stringify(update)).not.toContain(PRIVATE_KEY);
		await expect(
			runtime.db
				.selectFrom("options")
				.selectAll()
				.where("name", "=", `plugin:${plugin.id}:settings:privateReadKey`)
				.executeTakeFirst(),
		).resolves.toBeUndefined();
	});

	it("stores the secret encrypted, requires admin permission, validates the site, then renders its tracker", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
		const runtime = await makeRuntime();
		const plugin = runtime.configuredPlugins.find(({ id }) => id === "openanalytics");
		expect(plugin).toBeDefined();
		if (!plugin) return;
		const schema = plugin.admin?.settingsSchema;
		if (!schema) throw new Error("OpenAnalytics settings schema was not registered");

		let responsePayload: unknown = {
			site_id: "site_123",
			slug: "docs",
			name: "Docs",
			status: "active",
			install: {
				tracking_key: "oa_pk_public-key",
				script_url: "https://cdn.openanalytics.test/tracker.js",
				collector_url: "https://api.openanalytics.test/v1/collect",
			},
		};
		let responseStatus = 200;
		const fetchSpy = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify(responsePayload), {
					status: responseStatus,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const emptyHead = async () => {
			const result = await runtime.hooks.runPageFragments({
				page: { path: "/articles/hello" },
			} as never);
			return renderFragments(
				result.flatMap(({ contributions }) => contributions),
				"head",
			);
		};
		expect(await emptyHead()).toBe("");

		const stored = await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			apiUrl: "https://api.openanalytics.test",
			privateReadKey: PRIVATE_KEY,
			trackingEnabled: true,
		});
		expect(stored.success).toBe(true);
		expect(JSON.stringify(stored)).not.toContain(PRIVATE_KEY);

		const savedOption = await runtime.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", `plugin:${plugin.id}:settings:privateReadKey`)
			.executeTakeFirstOrThrow();
		expect(savedOption.value).not.toContain(PRIVATE_KEY);
		expect(JSON.parse(savedOption.value)).toMatchObject({
			$emdash: "plugin-setting",
			v: 1,
		});
		const reloaded = await handlePluginSettingsGet(runtime.db, plugin.id, schema);
		expect(JSON.stringify(reloaded)).not.toContain(PRIVATE_KEY);
		if (reloaded.success) {
			expect(reloaded.data.secretsSet.privateReadKey).toBe(true);
			expect("privateReadKey" in reloaded.data.values).toBe(false);
		}

		const unauthenticated = await validateConnection(runtime, plugin.id);
		expect(unauthenticated.status).toBe(401);
		expect(fetchSpy).not.toHaveBeenCalled();

		const csrfRejected = await validateConnection(runtime, plugin.id, {
			role: 50,
			skipScopes: true,
		});
		expect(csrfRejected.status).toBe(403);

		const permissionRejected = await validateConnection(runtime, plugin.id, {
			role: 40,
		});
		expect(permissionRejected.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();

		const response = await validateConnection(runtime, plugin.id, { role: 50 });
		expect(response.status).toBe(200);
		const responseText = await response.text();
		expect(responseText).toContain("site_123");
		expect(responseText).not.toContain(PRIVATE_KEY);
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.openanalytics.test/v1/read/site");

		const result = await runtime.hooks.runPageFragments({
			page: { path: "/articles/hello" },
		} as never);
		const html = renderFragments(
			result.flatMap(({ contributions }) => contributions),
			"head",
		);
		expect(html).toBe(
			'<script src="https://cdn.openanalytics.test/tracker.js" async data-key="oa_pk_public-key" data-collector="https://api.openanalytics.test/v1/collect"></script>',
		);
		expect(html).not.toContain(PRIVATE_KEY);
		expect(html).not.toContain("oa_sk_");
		const secondPageResult = await runtime.hooks.runPageFragments({
			page: { path: "/articles/hello" },
		} as never);
		const duplicateHtml = renderFragments(
			[...result, ...secondPageResult].flatMap(({ contributions }) => contributions),
			"head",
		);
		expect(duplicateHtml.match(/<script\b/g)).toHaveLength(1);
		expect(fetchSpy).toHaveBeenCalledOnce();

		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			apiUrl: "https://other-api.openanalytics.test",
		});
		expect(await emptyHead()).toBe("");
		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			apiUrl: "https://api.openanalytics.test",
		});
		expect(await emptyHead()).toContain("tracker.js");

		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			trackingEnabled: false,
		});
		const disabled = await runtime.hooks.runPageFragments({
			page: { path: "/articles/hello" },
		} as never);
		expect(
			renderFragments(
				disabled.flatMap(({ contributions }) => contributions),
				"head",
			),
		).toBe("");

		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			trackingEnabled: true,
		});
		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			privateReadKey: "oa_sk_another-credential",
		});
		expect(await emptyHead()).toBe("");

		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			privateReadKey: null,
		});
		expect(await emptyHead()).toBe("");
		const missingSecret = await handlePluginSettingsGet(runtime.db, plugin.id, schema);
		if (missingSecret.success) expect(missingSecret.data.secretsSet.privateReadKey).toBe(false);
		expect(fetchSpy).toHaveBeenCalledOnce();

		await handlePluginSettingsUpdate(runtime.db, plugin.id, schema, {
			privateReadKey: PRIVATE_KEY,
		});
		responsePayload = {
			site_id: "site_123",
			slug: "docs",
			name: "Docs",
			status: "active",
			install: {
				tracking_key: "oa_pk_public-key",
				script_url: "javascript:alert(1)",
				collector_url: "https://api.openanalytics.test/v1/collect",
			},
		};
		const unsafeUrlResponse = await validateConnection(runtime, plugin.id, {
			role: 50,
		});
		expect(unsafeUrlResponse.status).toBe(200);
		expect(await emptyHead()).toBe("");

		for (const field of ["tracking_key", "script_url", "collector_url"] as const) {
			responsePayload = {
				site_id: "site_123",
				slug: "docs",
				name: "Docs",
				status: "active",
				install: {
					tracking_key: "oa_pk_public-key",
					script_url: "https://cdn.openanalytics.test/tracker.js",
					collector_url: "https://api.openanalytics.test/v1/collect",
					[field]: null,
				},
			};
			const nullableFieldResponse = await validateConnection(runtime, plugin.id, {
				role: 50,
			});
			expect(nullableFieldResponse.status).toBe(200);
			expect(await emptyHead()).toBe("");
		}

		responsePayload = {
			site_id: "site_123",
			slug: "docs",
			name: PRIVATE_KEY,
			status: "active",
			install: {
				tracking_key: "oa_pk_public-key",
				script_url: "https://cdn.openanalytics.test/tracker.js",
				collector_url: "https://api.openanalytics.test/v1/collect",
			},
		};
		const credentialLeakResponse = await validateConnection(runtime, plugin.id, {
			role: 50,
		});
		const safeError = await credentialLeakResponse.text();
		expect(safeError).not.toContain(PRIVATE_KEY);
		expect(await emptyHead()).toBe("");

		responsePayload = {
			site_id: "site_123",
			slug: "docs",
			name: "Docs",
			status: "active",
			install: {
				tracking_key: "oa_pk_public-key",
				script_url: "https://cdn.openanalytics.test/tracker.js",
				collector_url: "https://api.openanalytics.test/v1/collect",
			},
		};
		const validRevalidation = await validateConnection(runtime, plugin.id, {
			role: 50,
		});
		expect(validRevalidation.status).toBe(200);
		expect(await emptyHead()).toContain("tracker.js");

		responseStatus = 401;
		const failedRevalidation = await validateConnection(runtime, plugin.id, {
			role: 50,
		});
		expect(failedRevalidation.status).toBe(200);
		expect(await failedRevalidation.text()).toContain('"success":false');
		expect(await emptyHead()).toBe("");
	});

	it("never calls OpenAnalytics for EmDash admin URLs", async () => {
		const runtime = await makeRuntime();
		const plugin = runtime.configuredPlugins.find(({ id }) => id === "openanalytics");
		if (!plugin) throw new Error("OpenAnalytics plugin was not registered");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const result = await runtime.hooks.runPageFragments({
			page: { path: "/_emdash/api/admin" },
		} as never);
		expect(result.flatMap(({ contributions }) => contributions)).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
