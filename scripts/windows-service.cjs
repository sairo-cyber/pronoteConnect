const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const { join, resolve } = require("node:path");

if (process.platform !== "win32") {
  process.stderr.write("Ce gestionnaire est réservé à Windows.\n");
  process.exit(1);
}

const root = resolve(__dirname, "..");
const dataDir = join(root, ".data");
const pidFile = join(dataDir, "pronoteconnect.pid");
const serverEntry = join(root, "dist", "src", "index.js");
const tunnelClient = join(root, ".runtime", "tunnel-client", "tunnel-client.exe");
const logDir = join(dataDir, "logs");
const logFile = join(logDir, "pronoteconnect.log");
const previousLogFile = join(logDir, "pronoteconnect.previous.log");
const errorFile = join(logDir, "last-service-error.txt");

function prepareLog() {
  mkdirSync(logDir, { recursive: true });
  try {
    if (statSync(logFile).size > 2 * 1024 * 1024) {
      rmSync(previousLogFile, { force: true });
      renameSync(logFile, previousLogFile);
    }
  } catch {
  }
}

function saveError(message) {
  prepareLog();
  const safe = String(message).replace(/[\r\n]+/gu, " ").slice(0, 500);
  writeFileSync(errorFile, `${new Date().toISOString()} ${safe}\n`, { encoding: "utf8" });
}

function healthy(timeout = 500) {
  return new Promise((resolveHealth) => {
    const request = http.get("http://127.0.0.1:37421/health", (response) => {
      response.resume();
      resolveHealth(response.statusCode === 200);
    });
    request.setTimeout(timeout, () => request.destroy());
    request.once("error", () => resolveHealth(false));
  });
}

function readPid() {
  try {
    const value = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailscaleHost() {
  const candidates = [
    "tailscale.exe",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Tailscale", "tailscale.exe") : undefined,
  ].filter(Boolean);
  for (const command of candidates) {
    const result = spawnSync(command, ["ip", "-4"], { encoding: "utf8", windowsHide: true });
    const value = result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : undefined;
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}$/u.test(value ?? "")) return value;
  }
  return undefined;
}

async function waitForHealth(expected, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await healthy() === expected) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function start() {
  if (await healthy()) {
    process.stdout.write("PronoteConnect est déjà actif.\n");
    return;
  }
  const previousPid = readPid();
  if (previousPid && processExists(previousPid)) {
    if (await waitForHealth(true, 20)) return;
    rmSync(pidFile, { force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  prepareLog();
  const host = tailscaleHost();
  const logHandle = openSync(logFile, "a");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logHandle, logHandle],
    env: {
      ...process.env,
      PRONOTECONNECT_DATA_DIR: dataDir,
      PRONOTECONNECT_INSTALL_DIR: root,
      PRONOTECONNECT_TUNNEL_CLIENT: tunnelClient,
      PRONOTECONNECT_MANAGED_SERVICE: "1",
      PLAYWRIGHT_BROWSERS_PATH: join(root, ".runtime", "browsers"),
      ...(host ? { PRONOTECONNECT_TAILSCALE_HOST: host } : {}),
    },
  });
  writeFileSync(pidFile, `${child.pid}\n`, { encoding: "utf8" });
  child.unref();
  if (!await waitForHealth(true)) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    rmSync(pidFile, { force: true });
    throw new Error("PronoteConnect n'a pas démarré.");
  }
  rmSync(errorFile, { force: true });
  process.stdout.write("PronoteConnect est actif.\n");
}

async function stop() {
  const pid = readPid();
  if (pid && processExists(pid)) {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
  rmSync(pidFile, { force: true });
  await waitForHealth(false, 40);
  process.stdout.write("PronoteConnect est arrêté.\n");
}

async function main() {
  const action = process.argv[2] ?? "start";
  if (!existsSync(serverEntry)) throw new Error("Compilez PronoteConnect avant de le démarrer.");
  if (action === "start") await start();
  else if (action === "stop") await stop();
  else if (action === "restart") {
    await stop();
    await start();
  } else if (action === "status") {
    process.stdout.write(await healthy() ? "active\n" : "inactive\n");
  } else throw new Error(`Action inconnue : ${action}`);
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  saveError(message);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
