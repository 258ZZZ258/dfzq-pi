import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

export default mergeConfig(
	base,
	defineConfig({
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
