import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".data", ".runtime", ".git", "test-results", "playwright-report"]);
const ignoredFile = "scripts/security-scan.ts";
const textExtensions = new Set([".ts", ".js", ".mjs", ".cjs", ".sh", ".json", ".md", ".html", ".css", ".toml", ""]);
const forbidden = [
  new RegExp(`s${"k"}-[A-Za-z0-9_-]{20,}`, "u"),
  new RegExp(`Bearer\\s+[A-Za-z0-9._~+/${"="}-]{24,}`, "u"),
  new RegExp(`"to${"ken"}"\\s*:\\s*"[A-Za-z0-9._~+/${"="}-]{16,}"`, "u"),
];

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

const findings: string[] = [];
for (const path of await files(root)) {
  const name = relative(root, path);
  if (name === ignoredFile || !textExtensions.has(extname(path))) continue;
  if (/^\.env(?:\.|$)/u.test(name)) findings.push(`${name}: fichier d'environnement non autorisé`);
  const content = await readFile(path, "utf8");
  if (forbidden.some((pattern) => pattern.test(content))) findings.push(`${name}: motif ressemblant à un secret`);
}

if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Aucun motif de secret concret détecté dans les fichiers du projet.\n");
}
