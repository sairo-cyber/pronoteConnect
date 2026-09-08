import { Dpapi, isPlatformSupported } from "@primno/dpapi";

export async function protectForCurrentWindowsUser(cleartext: Buffer): Promise<string> {
  if (!isPlatformSupported) throw new Error("WINDOWS_DPAPI_UNAVAILABLE");
  return Buffer.from(Dpapi.protectData(cleartext, null, "CurrentUser")).toString("base64");
}

export async function unprotectForCurrentWindowsUser(encrypted: string): Promise<Buffer> {
  if (!isPlatformSupported) throw new Error("WINDOWS_DPAPI_UNAVAILABLE");
  return Buffer.from(Dpapi.unprotectData(Buffer.from(encrypted, "base64"), null, "CurrentUser"));
}

export async function windowsDpapiAvailable(): Promise<boolean> {
  if (!isPlatformSupported) return false;
  try {
    const probe = Buffer.from("pronoteconnect", "utf8");
    const encrypted = await protectForCurrentWindowsUser(probe);
    return (await unprotectForCurrentWindowsUser(encrypted)).equals(probe);
  } catch {
    return false;
  }
}
