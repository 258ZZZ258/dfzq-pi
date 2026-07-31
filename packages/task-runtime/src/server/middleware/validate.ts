import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/**
 * body 校验用 typebox —— 与工具 schema 同一套,不引第二个校验库(设计文档 §5.2)。
 */
const FiltersSchema = Type.Object({
	permTags: Type.Optional(Type.Array(Type.String())),
	corpusTypes: Type.Array(Type.String()),
	projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const SubmitBodySchema = Type.Object({
	taskKind: Type.String({ minLength: 1 }),
	input: Type.String({ minLength: 1 }),
	clientRequestId: Type.String({ minLength: 1 }),
	requestId: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	filters: FiltersSchema,
	options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	waitMs: Type.Optional(Type.Number()),
});

export type SubmitBody = Static<typeof SubmitBodySchema>;

export type ValidationError = { code: string; message: string };

/** 缺省与服务端上限同值:服务端不允许比缺省等更久。 */
export const WAIT_MS_DEFAULT = 30_000;
/**
 * ⚠ 临时值。必须小于链路上最短的超时,需 Java 侧给出 client 读超时与网关
 * proxy_read_timeout 后上调(设计文档 §10-2)。取错会产生「Java 超时了但 run 还在跑」的孤儿。
 */
export const WAIT_MS_MAX = 30_000;

export function clampWaitMs(raw: number | undefined): number {
	if (raw === undefined || Number.isNaN(raw)) return WAIT_MS_DEFAULT;
	return Math.min(Math.max(raw, 0), WAIT_MS_MAX);
}

export function validateSubmitBody(
	raw: unknown,
): { ok: true; body: SubmitBody } | { ok: false; error: ValidationError } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: { code: "invalid_body", message: "request body must be a JSON object" } };
	}
	// 授权位先判,且判在通用 schema 之前 —— 缺 filters 要回专有 code,
	// 不能混进 invalid_body 让 Java 侧分不清「格式错」与「未授权」。
	const filters = (raw as { filters?: unknown }).filters;
	if (typeof filters !== "object" || filters === null) {
		return {
			ok: false,
			error: { code: "missing_authorization_scope", message: "filters is required and must be an object" },
		};
	}
	// 元素类型也要在授权预检里查:形状合法(非空数组)但元素类型不对,
	// 本质是「伪装成合法形状的授权探测」,不能落到下面的通用 schema 报 invalid_body,
	// 否则 Java 侧就分不清「格式错」与「授权位可疑」(复审 Important ①)。
	const corpusTypes = (filters as { corpusTypes?: unknown }).corpusTypes;
	// 元素还要求非空字符串:空串放行会让 corpusTypes: [""] 混进「形状合法」的分支,而设计
	// 文档写的是「绝不默认放行」——这里必须留在授权预检里判(不能挪去给 schema 加
	// minLength,那会让报错退回 invalid_body,把「授权位要用专有 code」的修复撞回去)。
	if (
		!Array.isArray(corpusTypes) ||
		corpusTypes.length === 0 ||
		!corpusTypes.every((v) => typeof v === "string" && v.length > 0)
	) {
		return {
			ok: false,
			error: {
				code: "missing_authorization_scope",
				message: "filters.corpusTypes must be a non-empty array of strings",
			},
		};
	}
	if (!Value.Check(SubmitBodySchema, raw)) {
		// typebox 1.1.38 的 TLocalizedValidationError 用 instancePath,不是 path
		// (与 brief 假设的字段名不同,已用 node -e 实测确认后按实测改)。
		const first = [...Value.Errors(SubmitBodySchema, raw)][0];
		return {
			ok: false,
			error: { code: "invalid_body", message: first ? `${first.instancePath}: ${first.message}` : "invalid body" },
		};
	}
	return { ok: true, body: raw as SubmitBody };
}
