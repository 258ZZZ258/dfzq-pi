import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { readBoundedLines } from "../src/toolsets/mcp/lines.ts";

it("rejects an oversized partial protocol line before newline", () => {
	const stream = new PassThrough();
	let overflow = false;
	readBoundedLines(stream, {
		maxBytes: 8,
		onLine: () => {
			throw new Error("must not deliver partial JSON");
		},
		onOverflow: () => {
			overflow = true;
		},
	});
	stream.write("12345678");
	expect(overflow).toBe(false);
	stream.write("9");
	expect(overflow).toBe(true);
	stream.destroy();
});
it("drains and truncates stderr lines, then continues with the next line", () => {
	const stream = new PassThrough();
	const lines: string[] = [];
	const reader = readBoundedLines(stream, { maxBytes: 8, truncate: true, onLine: (line) => lines.push(line) });
	stream.write("x".repeat(100000));
	stream.write("\nnext\n");
	expect(lines).toEqual(["xxxxxxxx", "next"]);
	reader.close();
	stream.destroy();
});
it("preserves UTF-8 split across chunks", () => {
	const stream = new PassThrough();
	const lines: string[] = [];
	const reader = readBoundedLines(stream, { maxBytes: 100, onLine: (line) => lines.push(line) });
	const text = Buffer.from("中文\n");
	for (const byte of text) stream.write(Buffer.from([byte]));
	expect(lines).toEqual(["中文"]);
	reader.close();
	stream.destroy();
});
