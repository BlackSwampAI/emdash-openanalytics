import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

// Prefix checks and examples are expected; a concrete private credential is not.
for (const file of await readdir(resolve(root, "dist"))) {
	const contents = await readFile(resolve(root, "dist", file), "utf8");
	assert(!/oa_sk_[A-Za-z0-9_-]{8,}/.test(contents), `Private credential in ${file}`);
}
console.log("Package exports, native metadata, and artifact credential scan passed.");
