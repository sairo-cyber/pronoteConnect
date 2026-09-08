import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CapturedMobileLogin } from "../pronote/connector.js";
import { normalizePronoteUrl } from "../pronote/url.js";

const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 PRONOTE Mobile";
const INFO_ID = "0D264427-EEFC-4810-A9E9-346942A862A4";

export interface OpenBrowserAuthSession {
  readonly deviceUUID: string;
  waitForMobileLogin(): Promise<CapturedMobileLogin>;
  close(): Promise<void>;
}

export interface BrowserAuthProvider {
  open(pronoteUrl: string): Promise<OpenBrowserAuthSession>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface ChromiumStatus {
  available: boolean;
  name?: string;
  path?: string;
}

async function available(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectChromiumExecutable(): Promise<ChromiumStatus> {
  const configured = process.env.PRONOTECONNECT_CHROMIUM_PATH;
  const candidates = process.platform === "win32"
    ? [
        configured,
        process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
        process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
      ]
    : process.platform === "darwin"
      ? [configured, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : [configured, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    candidates.push(undefined);
  }
  for (const candidate of candidates) {
    if (!candidate || !await available(candidate)) continue;
    const name = basename(candidate).toLowerCase();
    return {
      available: true,
      name: name.startsWith("google-chrome") || candidate.includes("Google Chrome.app") ? "Google Chrome" : "Chromium",
      path: candidate,
    };
  }
  return { available: false };
}

async function pageAtPronoteOrigin(context: BrowserContext, origin: string): Promise<Page | undefined> {
  const pages = context.pages();
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const page = pages[index];
    if (!page || page.isClosed()) continue;
    try {
      if (new URL(page.url()).origin === origin) return page;
    } catch {
      // les url transitoires comme about:blank ne sont pas inspectées
    }
  }
  return undefined;
}

export class PlaywrightBrowserAuthProvider implements BrowserAuthProvider {
  async open(value: string): Promise<OpenBrowserAuthSession> {
    const pronoteUrl = normalizePronoteUrl(value);
    const allowedOrigin = new URL(pronoteUrl).origin;
    const profilePath = await mkdtemp(join(tmpdir(), "pronoteconnect-auth-"));
    await chmod(profilePath, 0o700);
    const deviceUUID = randomUUID();
    let context: BrowserContext | undefined;
    try {
      const detected = await detectChromiumExecutable();
      context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        ...(detected.path ? { executablePath: detected.path } : {}),
        userAgent: MOBILE_USER_AGENT,
        viewport: { width: 430, height: 820 },
        locale: "fr-FR",
        timezoneId: "Europe/Paris",
        acceptDownloads: false,
        serviceWorkers: "block",
      });
    } catch (error) {
      await rm(profilePath, { recursive: true, force: true });
      if (/executable.*doesn.*exist|browser.*install/iu.test(String(error))) throw new Error("PLAYWRIGHT_CHROMIUM_NOT_INSTALLED");
      throw error;
    }

    const safeContext = context;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await safeContext.close().catch(() => undefined);
      await rm(profilePath, { recursive: true, force: true });
    };

    const page = safeContext.pages()[0] ?? await safeContext.newPage();
    await page.addInitScript(
      ({ origin, uuid }) => {
        if (window.location.origin !== origin) return;
        const installHook = (): void => {
          (window as unknown as Record<string, unknown>).hookAccesDepuisAppli = function pronoteMobileHook(this: { passerEnModeValidationAppliMobile?: (...args: unknown[]) => void }) {
            this.passerEnModeValidationAppliMobile?.("", uuid);
          };
        };
        installHook();
      },
      { origin: allowedOrigin, uuid: deviceUUID },
    );

    const infoUrl = `${pronoteUrl}/InfoMobileApp.json?id=${INFO_ID}`;
    await page.goto(infoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (new URL(page.url()).origin !== allowedOrigin) {
      await close();
      throw new Error("UNEXPECTED_INFO_MOBILE_REDIRECT");
    }
    const infoText = await page.evaluate(() => document.body.innerText);
    let info: { CAS?: { jetonCAS?: unknown } };
    try {
      info = JSON.parse(infoText) as { CAS?: { jetonCAS?: unknown } };
    } catch {
      await close();
      throw new Error("INVALID_INFO_MOBILE_RESPONSE");
    }
    const expires = Math.floor(Date.now() / 1_000) + 5 * 60;
    const oneYear = Math.floor(Date.now() / 1_000) + 365 * 24 * 60 * 60;
    const casToken = typeof info.CAS?.jetonCAS === "string" ? info.CAS.jetonCAS : undefined;
    await safeContext.addCookies([
      ...(casToken
        ? [
            { name: "validationAppliMobile", value: casToken, url: `${allowedOrigin}/`, expires, sameSite: "Lax" as const },
            { name: "uuidAppliMobile", value: deviceUUID, url: `${allowedOrigin}/`, expires, sameSite: "Lax" as const },
          ]
        : [{ name: "appliMobile", value: "1", url: `${allowedOrigin}/`, expires, sameSite: "Lax" as const }]),
      { name: "ielang", value: "1036", url: `${allowedOrigin}/`, expires: oneYear, sameSite: "Lax" as const },
    ]);
    await page.goto(`${pronoteUrl}/mobile.eleve.html?fd=1`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const waitForMobileLogin = async (): Promise<CapturedMobileLogin> => {
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        if (closed) throw new Error("AUTH_BROWSER_CLOSED");
        const pronotePage = await pageAtPronoteOrigin(safeContext, allowedOrigin);
        if (pronotePage) {
          const state = await pronotePage.evaluate(
            ({ origin, uuid }) => {
              if (window.location.origin !== origin) return null;
              const target = window as unknown as {
                GInterface?: { passerEnModeValidationAppliMobile?: (...args: unknown[]) => void };
                loginState?: { status?: unknown; login?: unknown; mdp?: unknown };
                __assistantPronoteMobileActivated?: boolean;
              };
              if (!target.__assistantPronoteMobileActivated && target.GInterface?.passerEnModeValidationAppliMobile) {
                target.__assistantPronoteMobileActivated = true;
                try {
                  target.GInterface.passerEnModeValidationAppliMobile("", uuid, "", "", '{"model":"PronoteConnect","platform":"android"}');
                } catch {
                  target.__assistantPronoteMobileActivated = false;
                }
              }
              const login = target.loginState;
              if (Number(login?.status) !== 0 || typeof login?.login !== "string" || typeof login?.mdp !== "string") return null;
              return { username: login.login, token: login.mdp };
            },
            { origin: allowedOrigin, uuid: deviceUUID },
          ).catch(() => null);
          if (state) return { url: pronoteUrl, username: state.username, token: state.token, deviceUUID };
        }
        await sleep(750);
      }
      throw new Error("AUTH_TIMEOUT");
    };

    return { deviceUUID, waitForMobileLogin, close };
  }
}
