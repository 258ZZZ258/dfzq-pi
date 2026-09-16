import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface LineReader {
	close(): void;
}
/** Bound partial lines as they arrive, not only after an attacker finally sends a newline. */
export function readBoundedLines(
	stream: Readable,
	options: { maxBytes: number; truncate?: boolean; onLine: (line: string) => void; onOverflow?: () => void },
): LineReader {
	const decoder = new StringDecoder("utf8");
	let buffer = "",
		bytes = 0,
		discarded = false,
		closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.pause();
		if (options.truncate && buffer) options.onLine(buffer);
		buffer = "";
	};
	const consume = (text: string) => {
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (!discarded) {
				const part = parts[i];
				const size = Buffer.byteLength(part);
				if (bytes + size > options.maxBytes) {
					if (!options.truncate) {
						close();
						options.onOverflow?.();
						return;
					}
					buffer += Buffer.from(part)
						.subarray(0, Math.max(0, options.maxBytes - bytes))
						.toString("utf8");
					discarded = true;
				} else {
					buffer += part;
					bytes += size;
				}
			}
			if (i < parts.length - 1) {
				options.onLine(buffer);
				buffer = "";
				bytes = 0;
				discarded = false;
			}
		}
	};
	const onData = (chunk: Buffer | string) => {
		if (!closed) consume(decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
	};
	const onEnd = () => {
		if (!closed) {
			consume(decoder.end());
			close();
		}
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return { close };
}
