import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("message", (message) => {
	if (message.method === "init") process.send({ version: 1, id: message.id, result: { id: "test", specId: "demo", sessionId: "s", snapshot: { sessionId: "s" } } });
	if (message.method === "run") {
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		writeFileSync(process.env.PID_FILE, String(child.pid));
		while (true) { /* deliberately non-cooperative plugin */ }
	}
});
