export const PACKAGE_NAME = "@dfzq/task-runtime";

export type { ProviderProfile, RoleBinding } from "./env/provider-profile.ts";
export { reconcile, reconcileRunEvents } from "./observability/reconcile.ts";
export { attachTrajectory, readTrajectory } from "./observability/trajectory.ts";
export { loadSpecRouter, SpecRouter } from "./router/router.ts";
export { assemble } from "./runtime/assembler.ts";
export type {
	LimitKind,
	RunOptions,
	RunResult,
	RunStatus,
	Runtime,
	RuntimeEvent,
	RuntimeSnapshot,
	RunUsage,
} from "./runtime/contract.ts";
export { createDefaultPluginRegistry, type DefaultPluginDeps } from "./runtime/default-plugins.ts";
export { PluginRegistry } from "./runtime/plugin-registry.ts";
export { createSessionRuntime } from "./runtime/session-runtime.ts";
export { type AppOptions, createApp } from "./server/app.ts";
export { Gate, type GateOptions, type GateRejection } from "./server/gate.ts";
export {
	createDefaultRuntimeFactory,
	type DefaultFactoryOptions,
	type ServeOptions,
	startServer,
} from "./server/main.ts";
// RuntimeFactory 必须导出:ServeOptions 把它列为必填,外部消费方要能给自己的工厂标类型。
export {
	RunManager,
	type RuntimeFactory,
	type SubmitOutcome,
	type SubmitRequest,
} from "./server/run-manager.ts";
export type { RuntimeSpec } from "./spec/types.ts";
export { validateSpec } from "./spec/validate.ts";
export type { RunRecord, RunStore, StoredRunStatus } from "./store/contract.ts";
export { createSqliteRunStore } from "./store/sqlite.ts";
export { createMcpToolset } from "./toolsets/mcp/adapter.ts";
export { McpClient } from "./toolsets/mcp/client.ts";
export { ToolsetRegistry } from "./toolsets/registry.ts";
