import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const child = spawn(process.execPath, [join(root, "dist", "src", "index.js")], {
  env: { ...process.env, PRONOTECONNECT_ADAPTER: "fake", PRONOTECONNECT_INSTALL_DIR: root },
  stdio: "inherit",
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
