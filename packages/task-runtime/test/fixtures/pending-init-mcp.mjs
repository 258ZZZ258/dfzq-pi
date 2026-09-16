import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "initialize" && process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
});
