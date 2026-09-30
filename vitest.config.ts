import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"virtual:emdash/config": fileURLToPath(new URL("./tests/virtual-config.ts", import.meta.url)),
			"virtual:emdash/scheduler": fileURLToPath(
				new URL("./tests/virtual-scheduler.ts", import.meta.url),
			),
		},
	},
	test: {
		include: ["src/**/*.test.ts", "src/**/*.spec.ts", "test/**/*.test.ts", "tests/**/*.test.ts"],
		server: { deps: { inline: ["emdash"] } },
	},
});
