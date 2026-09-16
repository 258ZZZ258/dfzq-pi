import { fork } from "node:child_process";
import { workerMessage } from "./protocol.ts";

// This process never loads models/plugins. It remains responsive if its worker blocks.
const entry = process.argv[2];
if (!entry || !process.send) throw new Error("guardian requires an entry and IPC parent");
const child = fork(entry, [], {
	execArgv: ["--experimental-strip-types"],
	stdio: ["ignore", "ignore", "ignore", "ipc"],
	env: process.env,
});
const terminate = () => {
	try {
		process.kill(-process.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
		process.exit(1);
	}
};
process.on("disconnect", terminate);
process.on("message", (message) => {
	if (!workerMessage(message)) {
		terminate();
		return;
	}
	if (child.connected)
		child.send(message, (error) => {
			if (error) terminate();
		});
});
child.on("message", (message) => {
	if (!workerMessage(message) || !process.connected) {
		terminate();
		return;
	}
	process.send?.(message, (error: Error | null) => {
		if (error) terminate();
	});
});
child.on("error", terminate);
child.on("exit", terminate);
