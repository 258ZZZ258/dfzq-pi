import type { Embedder } from "./service.ts";

export function createHttpEmbedder(options: {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs?: number;
}): Embedder {
	return {
		id: `${options.baseUrl}:${options.model}`,
		async embed(text) {
			const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/embeddings`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
				},
				body: JSON.stringify({ model: options.model, input: text }),
				signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
			});
			if (!response.ok || !response.body) throw new Error("memory_embedding_failed");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					length += chunk.value.length;
					if (length > 2 * 1024 * 1024) throw new Error("memory_embedding_response_too_large");
					chunks.push(chunk.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: Array<{ embedding?: number[] }> };
			const vector = body.data?.[0]?.embedding;
			if (!Array.isArray(vector) || vector.length < 1 || vector.length > 4096 || !vector.every(Number.isFinite))
				throw new Error("memory_embedding_invalid");
			return vector;
		},
	};
}
