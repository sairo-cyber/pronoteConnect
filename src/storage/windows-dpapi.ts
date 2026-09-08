import { spawn } from "node:child_process";

const protectScript = [
  "$value = [Console]::In.ReadToEnd()",
  "$clear = [Convert]::FromBase64String($value)",
  "$encrypted = [Security.Cryptography.ProtectedData]::Protect($clear, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($encrypted))",
].join("; ");

const unprotectScript = [
  "$value = [Console]::In.ReadToEnd()",
  "$encrypted = [Convert]::FromBase64String($value)",
  "$clear = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($clear))",
].join("; ");

function run(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) child.kill();
      else stderr.push(chunk);
    });
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(`WINDOWS_DPAPI_FAILED_${code ?? 1}`));
    });
    child.stdin.end(input);
  });
}

export async function protectForCurrentWindowsUser(cleartext: Buffer): Promise<string> {
  return run(protectScript, cleartext.toString("base64"));
}

export async function unprotectForCurrentWindowsUser(encrypted: string): Promise<Buffer> {
  return Buffer.from(await run(unprotectScript, encrypted), "base64");
}

export async function windowsDpapiAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const probe = Buffer.from("pronoteconnect", "utf8");
    const encrypted = await protectForCurrentWindowsUser(probe);
    return (await unprotectForCurrentWindowsUser(encrypted)).equals(probe);
  } catch {
    return false;
  }
}
