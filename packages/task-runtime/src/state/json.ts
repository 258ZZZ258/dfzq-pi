import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
	const seen = new WeakSet<object>();
	const normalize = (item: unknown, depth: number): unknown => {
		if (depth > 128) throw new Error("JSON nesting limit exceeded");
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object") throw new Error("state must contain JSON values only");
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			throw new Error("state must contain plain JSON objects");
		if (seen.has(item)) throw new Error("cyclic state is not supported");
		seen.add(item);
		const result = Array.isArray(item)
			? item.map((v) => normalize(v, depth + 1))
			: Object.fromEntries(
					Object.keys(item)
						.sort()
						.map((key) => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]),
				);
		seen.delete(item);
		return result;
	};
	return JSON.stringify(normalize(value, 0));
}

export function hashState(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
