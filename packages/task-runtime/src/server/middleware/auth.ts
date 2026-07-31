import { createHash, timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";

export type AuthOutcome = "ok" | "boundary_closed" | "unauthorized";

/** timingSafeEqual 要求两侧等长,直接比原串会在长度不等时抛,并且泄漏长度。 */
function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

/**
 * `expected` 未配置 = **边界关闭**(fail-closed),不是「放行」。
 * 对齐 audit-ai 的 BOUNDARY-v1 §鉴权;⚠ 是否与 AUDIT_AI_INTERNAL_TOKEN 共用同一个 token
 * 仍待 Java 侧确认(设计文档 §10-3),当前按两套独立实现。
 *
 * 该头不承载用户身份,只证明调用方是 Java 后端;身份与权限已由 Java jCasbin
 * 折算进 `filters`(设计文档 D11),这里不做、也不应做鉴权之外的事。
 */
export function checkInternalToken(presented: string | undefined, expected: string | undefined): AuthOutcome {
	if (!expected) return "boundary_closed";
	if (!presented) return "unauthorized";
	return timingSafeEqual(digest(presented), digest(expected)) ? "ok" : "unauthorized";
}
