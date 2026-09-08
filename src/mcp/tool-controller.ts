import type { PronoteConnector } from "../pronote/connector.js";
import { PronoteConnectionError } from "../pronote/connector.js";
import { dateRangeFromInput } from "../domain/dates.js";

export interface ToolSuccess<T = unknown> {
  ok: true;
  data: T;
  timezone: "Europe/Paris";
}

export interface ToolFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    reconnectRequired: boolean;
  };
}

export class ToolController {
  constructor(readonly connector: PronoteConnector) {}

  async connectionStatus() {
    return this.connector.connectionStatus();
  }

  async listHomework(from: string, to: string) {
    return this.connector.listHomework(dateRangeFromInput(from, to));
  }

  async getHomework(homeworkId: string) {
    const homework = await this.connector.getHomework(homeworkId);
    if (!homework) throw new Error("HOMEWORK_NOT_FOUND_OR_NOT_LISTED");
    return homework;
  }

  async getTimetable(from: string, to: string) {
    return this.connector.getTimetable(dateRangeFromInput(from, to));
  }

  async listPeriods() {
    return this.connector.listPeriods();
  }

  async getGrades(periodId: string) {
    return this.connector.getGrades(periodId);
  }

  async listAttachments(parentId: string) {
    return this.connector.listAttachments(parentId);
  }

  async readAttachment(attachmentId: string, maxCharacters?: number) {
    return this.connector.readAttachment(attachmentId, maxCharacters);
  }
}

export function safeToolError(error: unknown): ToolFailure {
  if (error instanceof PronoteConnectionError) {
    const message = error.code === "NOT_CONNECTED"
      ? "PRONOTE n'est pas connecté. Ouvrez l'interface locale PronoteConnect pour vous connecter."
      : error.code === "TOKEN_EXPIRED"
        ? "Le jeton PRONOTE a expiré ou a été révoqué. Une reconnexion EduConnect est nécessaire."
        : "La connexion PRONOTE est indisponible.";
    return { ok: false, error: { code: error.code, message, reconnectRequired: true } };
  }
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  const allowed: Record<string, string> = {
    INVALID_DATE: "Une date est invalide.",
    INVALID_DATE_RANGE: "La date de fin précède la date de début.",
    DATE_RANGE_TOO_LARGE: "La plage demandée dépasse 62 jours.",
    HOMEWORK_NOT_FOUND_OR_NOT_LISTED: "Ce devoir n'a pas été trouvé. Relancez d'abord pronote_list_homework.",
    PERIOD_NOT_FOUND: "Cette période n'a pas été trouvée. Relancez pronote_list_periods.",
    ATTACHMENT_NOT_FOUND: "Ce document n'a pas été trouvé.",
    ATTACHMENT_NOT_FOUND_OR_NOT_LISTED: "Ce document n'est plus référencé. Relistez le devoir, le cours ou la note.",
    LINK_ATTACHMENT_NOT_DOWNLOADABLE: "Les liens externes sont listés mais ne sont jamais téléchargés par cet outil.",
    ATTACHMENT_TOO_LARGE: "Le document dépasse la limite locale autorisée.",
    ATTACHMENT_DOMAIN_REFUSED: "Le domaine de téléchargement du document a été refusé.",
    ATTACHMENT_PATH_REFUSED: "Le chemin de téléchargement du document a été refusé.",
    ATTACHMENT_SCHEME_REFUSED: "Le protocole de téléchargement du document a été refusé.",
    ATTACHMENT_DOWNLOAD_FAILED: "Le document n'a pas pu être téléchargé depuis PRONOTE.",
  };
  return {
    ok: false,
    error: {
      code: allowed[code] ? code : "PRONOTE_READ_FAILED",
      message: allowed[code] ?? "La lecture PRONOTE a échoué sans exposer de détail sensible.",
      reconnectRequired: false,
    },
  };
}
