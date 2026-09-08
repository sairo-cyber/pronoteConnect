import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthCoordinator } from "../src/auth/auth-coordinator.js";
import type { BrowserAuthProvider, OpenBrowserAuthSession } from "../src/auth/browser-auth-provider.js";
import type { CapturedMobileLogin, InteractivePronoteConnector, LoginCompletion } from "../src/pronote/connector.js";
import { FakePronoteConnector } from "../src/pronote/fake-connector.js";
import type { StoredCredential } from "../src/domain/types.js";

const quietLogger = { info() {}, warn() {}, error() {} };

function captured(): CapturedMobileLogin {
  return {
    url: "https://school.example/pronote",
    username: randomUUID(),
    token: randomBytes(24).toString("base64url"),
    deviceUUID: randomUUID(),
  };
}

function stored(login: CapturedMobileLogin): StoredCredential {
  return {
    schemaVersion: 1,
    pronoteUrl: login.url,
    username: login.username,
    accountKind: "STUDENT",
    deviceUUID: login.deviceUUID,
    token: login.token,
    lastConnectedAt: new Date().toISOString(),
  };
}

class FakeInteractiveConnector extends FakePronoteConnector implements InteractivePronoteConnector {
  constructor(readonly completion: (login: CapturedMobileLogin) => Promise<LoginCompletion>) {
    super();
  }

  completeCapturedLogin(login: CapturedMobileLogin): Promise<LoginCompletion> {
    return this.completion(login);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function provider(login: CapturedMobileLogin, onClose: () => void): BrowserAuthProvider {
  return {
    async open(): Promise<OpenBrowserAuthSession> {
      return { deviceUUID: login.deviceUUID, waitForMobileLogin: async () => login, close: async () => onClose() };
    },
  };
}

describe("parcours navigateur factice", () => {
  it("ne ferme le profil temporaire qu'après l'échange réussi", async () => {
    const login = captured();
    let closed = false;
    const connector = new FakeInteractiveConnector(async (value) => {
      expect(closed).toBe(false);
      return { credential: stored(value) };
    });
    const coordinator = new AuthCoordinator(provider(login, () => { closed = true; }), connector, quietLogger);
    await coordinator.start(login.url);
    await waitUntil(() => coordinator.status().phase === "success");
    expect(closed).toBe(true);
  });

  it("garde le navigateur ouvert pendant la validation PIN", async () => {
    const login = captured();
    let closed = false;
    let acceptedPin = "";
    const connector = new FakeInteractiveConnector(async (value) => ({
      credential: stored(value),
      pendingSecurity: {
        submitPin: async (pin) => {
          acceptedPin = pin;
          return stored(value);
        },
      },
    }));
    const coordinator = new AuthCoordinator(provider(login, () => { closed = true; }), connector, quietLogger);
    await coordinator.start(login.url);
    await waitUntil(() => coordinator.status().phase === "waiting_for_pin");
    expect(closed).toBe(false);
    await coordinator.submitPin("1234");
    expect(acceptedPin).toBe("1234");
    expect(coordinator.status().phase).toBe("success");
    expect(closed).toBe(true);
  });
});
