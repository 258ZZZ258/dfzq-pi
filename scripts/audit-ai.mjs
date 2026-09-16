import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../services/audit-ai/", import.meta.url));
const localPython = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.DFZQ_AUDIT_AI_PYTHON ?? (existsSync(localPython) ? localPython : "python3");
const child = spawn(python, [join(root, "service.py"), ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: "inherit" });
child.on("error", (error) => { console.error(`audit-ai launcher: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
