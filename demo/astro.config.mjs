import { fileURLToPath } from "node:url";

import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

import { openAnalytics } from "../dist/index.mjs";

const descriptor = openAnalytics();

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	devToolbar: { enabled: false },
	server: {
		host: "127.0.0.1",
		port: Number(process.env.EMDASH_DEMO_PORT ?? 4390),
		strictPort: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: process.env.EMDASH_DEMO_DB_URL ?? "file:./data.db" }),
			plugins: [
				{
					...descriptor,
					entrypoint: fileURLToPath(new URL("../dist/index.mjs", import.meta.url)),
				},
			],
		}),
	],
});
