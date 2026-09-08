import type { BrowserAuthProvider, OpenBrowserAuthSession } from "./browser-auth-provider.js";
import type { BrowserLoginState, InteractivePronoteConnector, LoginCompletion } from "../pronote/connector.js";
import type { SafeLogger } from "../security/redaction.js";

export class AuthCoordinator {
  readonly #browser: BrowserAuthProvider;
  readonly #connector: InteractivePronoteConnector;
  readonly #logger: SafeLogger;
  #state: BrowserLoginState = { phase: "idle", message: "Aucune connexion en cours.", pinRequired: false };
  #session: OpenBrowserAuthSession | null = null;
  #pending: LoginCompletion["pendingSecurity"];

  constructor(browser: BrowserAuthProvider, connector: InteractivePronoteConnector, logger: SafeLogger) {
    this.#browser = browser;
    this.#connector = connector;
    this.#logger = logger;
  }

  status(): BrowserLoginState {
    return { ...this.#state };
  }

  async start(url: string): Promise<void> {
    if (!["idle", "success", "error"].includes(this.#state.phase)) throw new Error("AUTH_ALREADY_RUNNING");
    await this.cancel();
    this.#state = { phase: "opening_browser", message: "Ouverture de la fenêtre EduConnect…", pinRequired: false };
    void this.#run(url);
  }

  async #run(url: string): Promise<void> {
    try {
      await this.#connector.validateInstance(url);
      this.#session = await this.#browser.open(url);
      this.#state = {
        phase: "waiting_for_user",
        message: "Saisissez vos identifiants uniquement dans la fenêtre officielle ENT/EduConnect.",
        pinRequired: false,
      };
      const captured = await this.#session.waitForMobileLogin();
      this.#state = { phase: "exchanging_token", message: "Validation locale du jeton mobile avec PRONOTE…", pinRequired: false };
      const completion = await this.#connector.completeCapturedLogin(captured);
      this.#pending = completion.pendingSecurity;
      if (this.#pending) {
        this.#state = {
          phase: "waiting_for_pin",
          message: "PRONOTE demande le code PIN de validation de cet appareil.",
          pinRequired: true,
        };
        return;
      }
      await this.#finishSuccess();
    } catch (error) {
      this.#logger.error("Échec du parcours de connexion PRONOTE.", { errorName: error instanceof Error ? error.name : "Unknown" });
      this.#state = {
        phase: "error",
        message: this.#safeMessage(error),
        pinRequired: false,
      };
      await this.#session?.close().catch(() => undefined);
      this.#session = null;
      this.#pending = undefined;
    }
  }

  async submitPin(pin: string): Promise<void> {
    if (this.#state.phase !== "waiting_for_pin" || !this.#pending) throw new Error("PIN_NOT_EXPECTED");
    if (!/^\d{4}$/u.test(pin)) throw new Error("INVALID_PIN");
    this.#state = { phase: "exchanging_token", message: "Validation du code PIN avec PRONOTE…", pinRequired: false };
    try {
      await this.#pending.submitPin(pin);
      this.#pending = undefined;
      await this.#finishSuccess();
    } catch (error) {
      this.#state = { phase: "waiting_for_pin", message: "Code refusé ou expiré. Vérifiez le PIN PRONOTE.", pinRequired: true };
      throw error;
    }
  }

  async #finishSuccess(): Promise<void> {
    await this.#session?.close();
    this.#session = null;
    this.#state = { phase: "success", message: "PRONOTE est connecté.", pinRequired: false };
  }

  async cancel(): Promise<void> {
    await this.#session?.close().catch(() => undefined);
    this.#session = null;
    this.#pending = undefined;
    this.#state = { phase: "idle", message: "Aucune connexion en cours.", pinRequired: false };
  }

  #safeMessage(error: unknown): string {
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      PLAYWRIGHT_CHROMIUM_NOT_INSTALLED: "Chromium Playwright n'est pas installé. Lancez la commande d'installation indiquée dans la documentation locale.",
      AUTH_BROWSER_CLOSED: "La fenêtre a été fermée avant la validation du jeton.",
      AUTH_TIMEOUT: "Le délai de connexion a expiré. Relancez la connexion.",
      NOT_A_LIKELY_PRONOTE_URL: "L'URL ne ressemble pas à une instance PRONOTE.",
      STUDENT_SPACE_NOT_FOUND: "Aucun espace Élève n'a été trouvé sur cette instance.",
      UNSUPPORTED_SECURITY_CUSTOMIZATION: "PRONOTE demande une personnalisation de sécurité non prise en charge par ce prototype.",
    };
    return messages[code] ?? "La connexion n'a pas pu être validée. Aucun identifiant ni jeton n'a été journalisé.";
  }
}
