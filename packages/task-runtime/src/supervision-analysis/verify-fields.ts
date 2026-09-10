import { convertSupervisionExtractions, type FieldCheck } from "./extraction-adapter.ts";

export async function verifyAndConvertExtractions(results: unknown, mappings: unknown) {
	const checks: FieldCheck[] = [];
	convertSupervisionExtractions(results, mappings, undefined, checks);
	const verified = new Map<string, boolean>();
	if (!checks.length) return convertSupervisionExtractions(results, mappings, verified);
	const base = process.env.AUDIT_AI_BASE_URL;
	const token = process.env.AUDIT_AI_INTERNAL_TOKEN;
	if (!base || !token) throw new Error("Supervision field verification requires audit-ai configuration");
	for (let start = 0; start < checks.length; start += 8) {
		const batch = checks.slice(start, start + 8);
		const response = await fetch(`${base.replace(/\/+$/, "")}/v1/supervision/verify-fields`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": token },
			body: JSON.stringify({ claims: batch }),
			signal: AbortSignal.timeout(300000),
		});
		if (!response.ok) throw new Error(`Field verification failed: HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("verdicts" in body) || !Array.isArray(body.verdicts))
			throw new Error("Invalid field verification response");
		const expected = new Set(batch.map((check) => check.id));
		for (const raw of body.verdicts as unknown[]) {
			if (
				!raw ||
				typeof raw !== "object" ||
				!("id" in raw) ||
				typeof raw.id !== "string" ||
				!expected.delete(raw.id) ||
				!("supported" in raw) ||
				typeof raw.supported !== "boolean" ||
				!("reason" in raw) ||
				typeof raw.reason !== "string" ||
				!raw.reason.trim()
			)
				throw new Error("Invalid field verification verdict");
			verified.set(raw.id, raw.supported);
		}
		if (expected.size) throw new Error("Incomplete field verification response");
	}
	return convertSupervisionExtractions(results, mappings, verified);
}
