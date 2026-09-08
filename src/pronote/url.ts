const pronotePathPattern = /(?:^|\/)pronote(?:\/|$)/iu;

export function normalizePronoteUrl(value: string): string {
  let candidate = value.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)) candidate = `https://${candidate}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("UNSUPPORTED_URL_SCHEME");
  if (url.username || url.password) throw new Error("URL_CREDENTIALS_FORBIDDEN");
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
    throw new Error("LOCAL_PRONOTE_URL_FORBIDDEN");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/(?:mobile\.)?(?:eleve|parent|professeur)\.html.*$/iu, "");
  url.pathname = url.pathname.replace(/\/InfoMobileApp\.json$/iu, "");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/pronote";
  return url.toString().replace(/\/$/u, "");
}

export function looksLikePronoteUrl(value: string): boolean {
  try {
    const url = new URL(normalizePronoteUrl(value));
    return pronotePathPattern.test(url.pathname) || /pronote/iu.test(url.hostname);
  } catch {
    return false;
  }
}

export function assertAllowedAttachmentUrl(value: string, pronoteUrl: string): URL {
  const attachment = new URL(value);
  const instance = new URL(pronoteUrl);
  if (attachment.protocol !== "https:" && !(instance.protocol === "http:" && attachment.protocol === "http:")) {
    throw new Error("ATTACHMENT_SCHEME_REFUSED");
  }
  if (attachment.origin !== instance.origin) throw new Error("ATTACHMENT_DOMAIN_REFUSED");
  if (!attachment.pathname.toLowerCase().includes("/fichiersexternes/")) {
    throw new Error("ATTACHMENT_PATH_REFUSED");
  }
  return attachment;
}
