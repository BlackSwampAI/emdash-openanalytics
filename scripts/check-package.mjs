import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
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
assert.equal(descriptor.id, plugin.id);
assert.equal(descriptor.version, pkg.version);
assert.equal(plugin.version, pkg.version);
assert.equal(plugin.admin.settingsSchema.privateReadKey.type, "secret");
assert(plugin.capabilities.includes("hooks.page-fragments:register"));
assert.equal(typeof plugin.hooks["page:fragments"].handler, "function");
assert.equal(typeof plugin.routes["validate-connection"].handler, "function");
assert.equal(plugin.routes["validate-connection"].permission, "plugins:manage");
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
for (const { path } of packed.files) {
	assert(!/^(demo|scripts|tests)\//.test(path), `Development fixture packed: ${path}`);
	assert(!path.startsWith("docs/screenshots/"), `Screenshot packed: ${path}`);
	const contents = await readFile(resolve(root, path), "utf8");
	assert(!/oa_sk_[A-Za-z0-9_-]{8,}/.test(contents), `Private credential packed: ${path}`);
}
console.log("Package exports, native metadata, packed files, and artifact credential scan passed.");
