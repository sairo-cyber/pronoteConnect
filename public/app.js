let csrf = "";
let selectedInstance = null;
let pollHandle = null;
let lastAuthPhase = "idle";
let currentStatus = null;

const byId = (id) => document.getElementById(id);
const toggle = (id, visible) => byId(id).classList.toggle("hidden", !visible);

function setDot(id, state) {
  byId(id).className = `dot${state ? ` is-${state}` : ""}`;
}

function setBadge(id, ready, pendingText, readyText = "prêt") {
  const badge = byId(id);
  badge.textContent = ready ? readyText : pendingText;
  badge.className = `badge${ready ? " is-ready" : ""}`;
}

function notice(message, error = false) {
  const element = byId("notice");
  element.textContent = message;
  element.classList.toggle("is-error", error);
  element.classList.remove("hidden");
  window.setTimeout(() => element.classList.add("hidden"), 8_000);
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-PronoteConnect-CSRF": csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? "La demande a échoué.");
  return data;
}

function buttonResult(item, onClick, suffix = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result";
  const text = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = item.title;
  const span = document.createElement("span");
  span.textContent = item.subtitle;
  text.append(strong, span);
  button.append(text);
  if (suffix) {
    const small = document.createElement("small");
    small.textContent = suffix;
    button.append(small);
  }
  button.addEventListener("click", onClick);
  return button;
}

function updateSteps(status) {
  const done = [
    status.app.browser.available && status.app.managedService,
    status.tunnel.active,
    status.tunnel.pluginConfigured,
    status.connection.connected,
  ];
  const firstPending = done.findIndex((value) => !value);
  done.forEach((value, index) => {
    const marker = byId(`step-marker-${index + 1}`);
    marker.classList.toggle("is-done", value);
    marker.classList.toggle("is-current", index === firstPending);
  });
}

function renderStatus(status) {
  currentStatus = status;
  const connected = status.connection.connected;
  const installReady = status.app.browser.available && status.app.managedService;
  const completedCount = [installReady, status.tunnel.active, status.tunnel.pluginConfigured, connected].filter(Boolean).length;

  byId("global-status").textContent = status.complete ? "prêt" : `${completedCount}/4 configuré`;
  byId("global-status").className = `pill${status.complete ? " is-ready" : ""}`;

  setDot("service-dot", installReady ? "ok" : "warn");
  byId("service-state").textContent = status.app.managedService
    ? "actif et lancé automatiquement"
    : "actif, mais démarrage automatique non détecté";
  setDot("tunnel-dot", status.tunnel.active ? "ok" : status.tunnel.configured ? "warn" : "off");
  byId("tunnel-state").textContent = status.tunnel.message;
  setDot("plugin-dot", status.tunnel.pluginConfigured ? "ok" : "off");
  byId("plugin-state").textContent = status.tunnel.pluginConfigured ? "plugin personnel enregistré" : "plugin personnel à créer";
  setDot("pronote-dot", connected ? "ok" : status.connection.health === "expired" ? "warn" : "off");
  byId("pronote-state").textContent = connected
    ? `${status.connection.establishmentName ?? "compte élève"} est prêt`
    : status.connection.health === "expired" ? "jeton expiré, reconnectez-vous" : "compte à connecter";

  setBadge("install-badge", installReady, "à vérifier");
  setBadge("tunnel-badge", status.tunnel.active, status.tunnel.configured ? "démarrage" : "à configurer", "actif");
  setBadge("plugin-badge", status.tunnel.pluginConfigured, "à configurer", "enregistré");
  setBadge("pronote-badge", connected, "à connecter", "connecté");

  byId("install-path").textContent = status.app.installDir;
  byId("browser-state").textContent = status.app.browser.available ? status.app.browser.name ?? "chromium disponible" : "chromium absent";
  byId("autostart-state").textContent = status.app.managedService ? "activé" : "non détecté";
  byId("app-version").textContent = status.app.version;

  toggle("tunnel-details", status.tunnel.configured);
  byId("saved-tunnel-id").textContent = status.tunnel.tunnelId ?? "—";
  if (!byId("tunnel-id").value && status.tunnel.tunnelId) byId("tunnel-id").value = status.tunnel.tunnelId;
  toggle("tunnel-storage-warning", Boolean(status.tunnel.storageWarning));
  byId("tunnel-storage-warning").textContent = status.tunnel.storageWarning ?? "";

  toggle("plugin-details", status.tunnel.pluginConfigured);
  byId("saved-plugin-id").textContent = status.tunnel.pluginAppId ?? "—";
  if (!byId("plugin-id").value && status.tunnel.pluginAppId) byId("plugin-id").value = status.tunnel.pluginAppId;

  toggle("account-details", connected);
  byId("school-name").textContent = status.connection.establishmentName ?? "—";
  byId("class-name").textContent = status.connection.className ?? "—";
  byId("last-connected").textContent = status.connection.lastConnectedAt
    ? new Date(status.connection.lastConnectedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
    : "—";
  byId("storage-backend").textContent = status.connection.storageBackend === "system-keyring"
    ? "trousseau système"
    : status.connection.storageBackend === "windows-dpapi"
      ? "protection du compte windows"
      : status.connection.storageBackend === "memory" ? "mémoire de test" : "fichier local chiffré";
  toggle("storage-warning", Boolean(status.connection.storageWarning));
  byId("storage-warning").textContent = status.connection.storageWarning ?? "";
  toggle("pronote-selector", !connected);

  const running = ["opening_browser", "waiting_for_user", "exchanging_token"].includes(status.auth.phase);
  toggle("auth-progress", running || status.auth.phase === "error");
  toggle("pin-form", status.auth.pinRequired);
  byId("auth-phase").textContent = status.auth.phase === "error" ? "connexion interrompue" : "connexion en cours";
  byId("auth-message").textContent = status.auth.message;
  byId("auth-progress").querySelector(".spinner").classList.toggle("hidden", status.auth.phase === "error");
  if (status.auth.phase === "success" && lastAuthPhase !== "success") notice("PRONOTE est connecté. Le jeton reste sur cet ordinateur.");
  lastAuthPhase = status.auth.phase;

  toggle("complete-card", status.complete);
  updateSteps(status);
}

async function refreshStatus() {
  try {
    renderStatus(await api("/api/status"));
  } catch {
    setDot("service-dot", "off");
    byId("service-state").textContent = "le service ne répond pas";
  }
}

function setTab(tab) {
  const search = tab === "search";
  byId("tab-search").classList.toggle("is-active", search);
  byId("tab-search").setAttribute("aria-selected", String(search));
  byId("tab-url").classList.toggle("is-active", !search);
  byId("tab-url").setAttribute("aria-selected", String(!search));
  toggle("panel-search", search);
  toggle("panel-url", !search);
}

async function validateInstance(url) {
  try {
    const { instance } = await api("/api/instance/validate", { method: "POST", body: JSON.stringify({ url }) });
    selectedInstance = instance;
    byId("instance-name").textContent = instance.name;
    byId("instance-url").textContent = instance.normalizedUrl;
    byId("instance-cas").textContent = instance.casEnabled
      ? "parcours ent et educonnect détecté"
      : "le lycée peut demander une connexion directe pronote";
    toggle("instance-confirmation", true);
    byId("instance-confirmation").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    selectedInstance = null;
    toggle("instance-confirmation", false);
    notice(error.message, true);
  }
}

async function copy(value) {
  await navigator.clipboard.writeText(value);
  notice("Valeur copiée.");
}

async function initialize() {
  const bootstrap = await api("/api/bootstrap");
  csrf = bootstrap.csrf;
  if (bootstrap.mode === "fake") notice("Mode de démonstration avec des données anonymes.");
  await refreshStatus();
  pollHandle = window.setInterval(refreshStatus, 3_000);
}

byId("refresh-status").addEventListener("click", refreshStatus);
byId("copy-plugin-name").addEventListener("click", () => void copy("PronoteConnect"));
byId("copy-tunnel").addEventListener("click", () => {
  if (currentStatus?.tunnel.tunnelId) void copy(currentStatus.tunnel.tunnelId);
});

byId("tunnel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "vérification en cours";
  try {
    await api("/api/tunnel/configure", {
      method: "POST",
      body: JSON.stringify({ tunnelId: byId("tunnel-id").value, runtimeApiKey: byId("runtime-api-key").value }),
    });
    byId("runtime-api-key").value = "";
    notice("Le tunnel est enregistré. Son démarrage peut prendre quelques secondes.");
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "enregistrer et démarrer le tunnel";
  }
});

byId("restart-tunnel").addEventListener("click", async () => {
  try {
    await api("/api/tunnel/restart", { method: "POST", body: "{}" });
    notice("Le tunnel redémarre.");
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

byId("forget-tunnel").addEventListener("click", async () => {
  if (!window.confirm("Supprimer la clé locale, le profil du tunnel et l'identifiant du plugin ?")) return;
  try {
    await api("/api/tunnel", { method: "DELETE", body: "{}" });
    byId("tunnel-id").value = "";
    byId("plugin-id").value = "";
    notice("La configuration du tunnel est supprimée de cet ordinateur.");
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

byId("plugin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/tunnel/plugin", { method: "POST", body: JSON.stringify({ plugin: byId("plugin-id").value }) });
    notice("Le plugin personnel est enregistré.");
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

byId("tab-search").addEventListener("click", () => setTab("search"));
byId("tab-url").addEventListener("click", () => setTab("url"));
byId("url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await validateInstance(byId("pronote-url").value);
});

byId("city-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const citiesContainer = byId("city-results");
  byId("school-results").replaceChildren();
  citiesContainer.textContent = "recherche des villes";
  try {
    const { cities } = await api("/api/cities/search", { method: "POST", body: JSON.stringify({ query: byId("city-query").value }) });
    citiesContainer.replaceChildren(...cities.map((city) => buttonResult({
      title: city.name,
      subtitle: `${city.postalCode} · ${city.context}`,
    }, async () => {
      const schoolsContainer = byId("school-results");
      schoolsContainer.textContent = "recherche des lycées pronote";
      try {
        const { schools } = await api("/api/schools/search", {
          method: "POST",
          body: JSON.stringify({ latitude: city.latitude, longitude: city.longitude }),
        });
        schoolsContainer.replaceChildren(...schools.map((school) => buttonResult(
          { title: school.name, subtitle: school.url },
          () => validateInstance(school.url),
          `${school.distanceKm} km`,
        )));
        if (!schools.length) schoolsContainer.textContent = "aucun établissement pronote trouvé à proximité";
      } catch (error) {
        notice(error.message, true);
      }
    })));
    if (!cities.length) citiesContainer.textContent = "aucune ville trouvée";
  } catch (error) {
    citiesContainer.replaceChildren();
    notice(error.message, true);
  }
});

byId("start-auth").addEventListener("click", async () => {
  if (!selectedInstance || !window.confirm(`Ouvrir EduConnect pour ${selectedInstance.name} ?\n\nVotre mot de passe restera dans la fenêtre officielle.`)) return;
  try {
    await api("/api/auth/start", { method: "POST", body: JSON.stringify({ url: selectedInstance.normalizedUrl }) });
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

byId("cancel-auth").addEventListener("click", async () => {
  await api("/api/auth/cancel", { method: "POST", body: "{}" });
  await refreshStatus();
});

byId("pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/pin", { method: "POST", body: JSON.stringify({ pin: byId("pin").value }) });
    byId("pin").value = "";
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

byId("clear-cache").addEventListener("click", async () => {
  try {
    await api("/api/documents/clear", { method: "POST", body: "{}" });
    notice("Le cache des documents est vidé.");
  } catch (error) {
    notice(error.message, true);
  }
});

byId("disconnect").addEventListener("click", async () => {
  if (!window.confirm("Déconnecter PRONOTE et supprimer son jeton local ?")) return;
  try {
    await api("/api/disconnect", { method: "POST", body: "{}" });
    notice("PRONOTE est déconnecté.");
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

byId("delete-data").addEventListener("click", async () => {
  if (!window.confirm("Supprimer le jeton PRONOTE, les identifiants opaques et le cache local ?")) return;
  try {
    await api("/api/local-data", { method: "DELETE", body: "{}" });
    notice("Les données PRONOTE locales sont supprimées.");
    await refreshStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

window.addEventListener("beforeunload", () => {
  if (pollHandle) window.clearInterval(pollHandle);
});

initialize().catch(() => notice("PronoteConnect n'a pas pu charger son état.", true));
