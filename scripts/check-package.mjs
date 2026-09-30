import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.equal(pkg.name, "@blackswampai/emdash-plugin-openanalytics");
assert.equal(pkg.version, "0.1.0");
assert.equal(pkg.private, undefined);
assert.deepEqual(pkg.publishConfig, { access: "public" });
assert.equal(pkg.engines.node, ">=22.16");
assert.equal(pkg.peerDependencies.emdash, ">=1.0.1 <2");
assert.deepEqual(pkg.files, [
	"dist",
	"docs/implementation-footprint.md",
	"docs/upstream-contracts.md",
]);
assert.equal(pkg.main, pkg.exports["."].import);
assert.equal(pkg.types, pkg.exports["."].types);
await readFile(resolve(root, pkg.exports["."].import));
await readFile(resolve(root, pkg.exports["."].types));
const { openAnalytics, createPlugin } = await import(pkg.name);
assert.equal(typeof openAnalytics, "function");
assert.equal(typeof createPlugin, "function");
const descriptor = openAnalytics();
const plugin = createPlugin();
assert.equal(descriptor.entrypoint, pkg.name);
assert.equal(descriptor.format, "native");
assert.match(descriptor.id, /^[a-z0-9-]+$/);
assert.equal(descriptor.id, "openanalytics");
assert.equal(descriptor.id, plugin.id);
assert.equal(descriptor.version, pkg.version);
assert.equal(plugin.version, pkg.version);
assert.equal(plugin.admin.settingsSchema.privateReadKey.type, "secret");
assert(plugin.capabilities.includes("hooks.page-fragments:register"));
assert.equal(typeof plugin.hooks["page:fragments"].handler, "function");
assert.equal(typeof plugin.routes["validate-connection"].handler, "function");
assert.equal(plugin.routes["validate-connection"].permission, "plugins:manage");
assert.deepEqual(plugin.routes["validate-connection"].methods, ["POST"]);
assert.deepEqual(plugin.routes["validate-connection"].request, { body: "bytes", maxBytes: 4_096 });
assert.equal(typeof plugin.routes.admin.handler, "function");
assert.equal(plugin.routes.admin.permission, "plugins:manage");
assert.deepEqual(plugin.routes.admin.methods, ["POST"]);
assert(plugin.admin.pages.some((page) => page.path === "/analytics"));
assert.equal(plugin.admin.entry, undefined);

// Prefix checks and examples are expected; a concrete private credential is not.
for (const file of await readdir(resolve(root, "dist"))) {
	const contents = await readFile(resolve(root, "dist", file), "utf8");
	assert(!/oa_sk_[A-Za-z0-9_-]{8,}/.test(contents), `Private credential in ${file}`);
}
const cache = mkdtempSync(join(tmpdir(), "openanalytics-package-check-"));
let packed;
try {
	[packed] = JSON.parse(
		execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json", "--cache", cache], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
} finally {
	rmSync(cache, { recursive: true, force: true });
}
const allowedFiles = new Set([
	"package.json",
	"README.md",
	"LICENSE",
	"dist/index.mjs",
	"dist/index.d.mts",
	"docs/implementation-footprint.md",
	"docs/upstream-contracts.md",
]);
const packedFiles = packed.files.map(({ path }) => path).sort();
assert.deepEqual(packedFiles, [...allowedFiles].sort(), "Unexpected npm package file list");
for (const path of packedFiles) {
	const contents = await readFile(resolve(root, path), "utf8");
	assert(!/oa_sk_[A-Za-z0-9_-]{8,}/.test(contents), `Private credential packed: ${path}`);
	assert(!/(?:^|\/)\.env(?:\.|$)/m.test(contents), `Environment file reference packed: ${path}`);
	assert(!/\.(?:sqlite|sqlite3|db)(?:\W|$)/i.test(path), `Database artifact packed: ${path}`);
	assert(
		!/(?:\/home\/|\/tmp\/|\/Users\/|[A-Z]:\\Users\\)/.test(contents),
		`Local path packed: ${path}`,
	);
	assert(
		!/(?:from|import)\s+["'][^"']*(?:\.\/)?tests?\//.test(contents),
		`Test import packed: ${path}`,
	);
}
console.log("Package metadata, exports, exact file allowlist, and artifact safety checks passed.");
