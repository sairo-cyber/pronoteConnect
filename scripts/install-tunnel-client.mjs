import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

const root = resolve(process.cwd());
const runtimeRoot = join(root, ".runtime");
const target = join(runtimeRoot, "tunnel-client");
const temporary = join(runtimeRoot, `tunnel-client-${process.pid}.tmp`);
const platform = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const architecture = { x64: "amd64", arm64: "arm64" }[process.arch];

if (!platform || !architecture) throw new Error(`plateforme non prise en charge: ${process.platform}/${process.arch}`);

async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`téléchargement refusé: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 350 * 1024 * 1024) throw new Error("archive du tunnel trop volumineuse");
  return bytes;
}

async function findExecutable(folder, name) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name);
    if (item.isDirectory()) {
      const found = await findExecutable(path, name);
      if (found) return found;
    } else if (item.name === name) {
      return path;
    }
  }
  return undefined;
}

const releaseResponse = await fetch("https://api.github.com/repos/openai/tunnel-client/releases/latest", {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "PronoteConnect installer" },
  signal: AbortSignal.timeout(30_000),
});
if (!releaseResponse.ok) throw new Error("version du tunnel indisponible");
const release = await releaseResponse.json();
const tag = String(release.tag_name ?? "");
const archiveName = `tunnel-client-${tag}-${platform}-${architecture}.zip`;
const archiveAsset = release.assets?.find((asset) => asset.name === archiveName);
const sumsAsset = release.assets?.find((asset) => asset.name === "SHA256SUMS.txt");
if (!archiveAsset || !sumsAsset) throw new Error(`archive officielle absente: ${archiveName}`);

const [archive, sums] = await Promise.all([
  download(archiveAsset.browser_download_url),
  download(sumsAsset.browser_download_url),
]);
const expected = sums.toString("utf8").split(/\r?\n/u)
  .map((line) => line.trim().split(/\s+/u))
  .find((parts) => parts.at(-1) === archiveName)?.[0];
const actual = createHash("sha256").update(archive).digest("hex");
if (!expected || expected.toLowerCase() !== actual) throw new Error("somme de contrôle du tunnel invalide");

await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
await rm(temporary, { recursive: true, force: true });
await mkdir(temporary, { recursive: true, mode: 0o700 });
const entries = unzipSync(new Uint8Array(archive));
let extractedSize = 0;
for (const [entryName, content] of Object.entries(entries)) {
  const clean = normalize(entryName.replaceAll("\\", "/"));
  if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`) || clean.includes("\0")) {
    throw new Error("chemin invalide dans l'archive du tunnel");
  }
  extractedSize += content.byteLength;
  if (extractedSize > 500 * 1024 * 1024) throw new Error("contenu du tunnel trop volumineux");
  const destination = join(temporary, clean);
  if (entryName.endsWith("/")) await mkdir(destination, { recursive: true, mode: 0o700 });
  else {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: 0o600 });
  }
}

const executableSuffix = process.platform === "win32" ? ".exe" : "";
const binaryName = `tunnel-client${executableSuffix}`;
const archiveBinaryName = `tunnel-client-runtime-cloudflared${executableSuffix}`;
const binary = await findExecutable(temporary, archiveBinaryName) ?? await findExecutable(temporary, binaryName);
if (!binary) throw new Error("binaire du tunnel absent de l'archive");
const source = dirname(binary);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true, force: true });
if (basename(binary) !== binaryName) await copyFile(binary, join(target, binaryName));
if (process.platform !== "win32") {
  await chmod(join(target, binaryName), 0o700);
  const cloudflared = await findExecutable(target, "cloudflared");
  if (cloudflared) await chmod(cloudflared, 0o700);
}
await writeFile(join(target, "version.txt"), `${tag}\n${basename(archiveName)}\n${actual}\n`, { mode: 0o600 });
await rm(temporary, { recursive: true, force: true });
process.stdout.write(`tunnel-client ${tag} installé et vérifié\n`);
