import { APP_VERSION } from "../config.js";

const RELEASES_URL = "https://api.github.com/repos/sairo-cyber/pronoteConnect/releases/latest";
const GITHUB_ORIGIN = "https://github.com";
const CACHE_DURATION_MS = 6 * 60 * 60 * 1_000;

export interface UpdateStatus {
  checked: boolean;
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
}

let cached: { expiresAt: number; status: UpdateStatus } | undefined;

function parts(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function newerVersion(candidate: string, current = APP_VERSION): boolean {
  const next = parts(candidate);
  const installed = parts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return (next[index] ?? 0) > (installed[index] ?? 0);
  }
  return false;
}

export async function checkForUpdate(fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
  const useCache = fetcher === fetch;
  if (useCache && cached && cached.expiresAt > Date.now()) return cached.status;
  const fallback: UpdateStatus = { checked: false, available: false, currentVersion: APP_VERSION };
  try {
    const response = await fetcher(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "PronoteConnect update checker" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      const status = { ...fallback, checked: true };
      if (useCache) cached = { expiresAt: Date.now() + CACHE_DURATION_MS, status };
      return status;
    }
    if (!response.ok) return fallback;
    const release = await response.json() as { tag_name?: unknown; html_url?: unknown };
    if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") return fallback;
    const url = new URL(release.html_url);
    if (url.origin !== GITHUB_ORIGIN || !url.pathname.startsWith("/sairo-cyber/pronoteConnect/releases/")) return fallback;
    const status: UpdateStatus = {
      checked: true,
      available: newerVersion(release.tag_name),
      currentVersion: APP_VERSION,
      latestVersion: release.tag_name.replace(/^v/u, ""),
      releaseUrl: url.toString(),
    };
    if (useCache) cached = { expiresAt: Date.now() + CACHE_DURATION_MS, status };
    return status;
  } catch {
    return fallback;
  }
}
