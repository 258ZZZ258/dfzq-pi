import { defineConfig } from "vitest/config";

// Deliberately do not merge the monorepo's source aliases. These tests resolve
// exactly the installed Pi artifacts consumed by native Node deployment.
export default defineConfig({
	test: {
		include: ["test/run-lookup.test.ts", "test/report-runtime-boundaries.test.ts", "test/report-source-cancellation.test.ts", "test/server-bind.test.ts", "test/production-dependencies.test.ts", "test/cli.test.ts", "test/production-runtime.test.ts", "test/factory-turn-limit.test.ts", "test/assembly-lifecycle.test.ts", "test/output-delivery.test.ts", "test/delivery-receipt.test.ts", "test/durable-resume-http.test.ts", "test/memory-worker-http.test.ts", "test/authorization-http.test.ts", "test/authorization-runtime.test.ts", "test/authorization-mcp.test.ts", "test/interaction-worker-http.test.ts", "test/release-boundary.test.ts", "test/embedded-audit-service.test.ts", "test/integrated-report-worker.test.ts"],
	},
});
