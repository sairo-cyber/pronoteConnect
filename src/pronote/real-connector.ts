import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AccountKind,
  AssignmentReturnKind,
  AttachmentKind as PawnoteAttachmentKind,
  BadCredentialsError,
  SecurityError,
  SessionExpiredError,
  TabLocation,
  createSessionHandle,
  finishLoginManually,
  geolocation,
  gradesOverview,
  instance,
  loginToken,
  parseTimetable,
  resource,
  securitySave,
  securitySource,
  assignmentsFromIntervals,
  timetableFromIntervals,
  type Attachment as PawnoteAttachment,
  type GradeValue as PawnoteGradeValue,
  type Period as PawnotePeriod,
  type SessionHandle,
} from "@blockshub/pawnote-lts";
import type { CredentialStore } from "../storage/credential-store.js";
import type {
  AttachmentSummary,
  CityResult,
  Course,
  DateRange,
  Grade,
  GradeReport,
  GradeValue,
  Homework,
  InstanceValidation,
  Period,
  PublicConnectionStatus,
  SchoolResult,
  StoredCredential,
} from "../domain/types.js";
import { toParisIso } from "../domain/dates.js";
import { OpaqueIdService, ReferenceRegistry } from "../security/opaque-ids.js";
import type { SafeLogger } from "../security/redaction.js";
import { DocumentReader } from "../documents/document-reader.js";
import {
  PronoteConnectionError,
  type CapturedMobileLogin,
  type InteractivePronoteConnector,
  type LoginCompletion,
} from "./connector.js";
import { looksLikePronoteUrl, normalizePronoteUrl } from "./url.js";

const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 PRONOTE Mobile APP Version/2.0.11";

type PawnoteFetcher = NonNullable<Parameters<typeof createSessionHandle>[0]>;

const pawnoteFetcher: PawnoteFetcher = async (options) => {
  const init: RequestInit = {
    headers: { ...Object.fromEntries(new Headers(options.headers).entries()), "User-Agent": MOBILE_USER_AGENT },
  };
  if (options.method) init.method = options.method;
  if (options.method && options.method !== "GET" && options.content !== undefined) init.body = options.content;
  if (options.redirect) init.redirect = options.redirect;
  const response = await fetch(options.url, init);
  return { content: await response.text(), status: response.status, headers: response.headers };
};

function plainText(value: string | undefined): string {
  return (value ?? "")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+\n/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function returnType(kind: number): Homework["returnType"] {
  switch (kind) {
    case AssignmentReturnKind.None: return "none";
    case AssignmentReturnKind.Paper: return "paper";
    case AssignmentReturnKind.FileUpload: return "file_upload";
    case AssignmentReturnKind.Kiosk: return "kiosk";
    case AssignmentReturnKind.AudioRecording: return "audio_recording";
    default: return "unknown";
  }
}

function gradeValue(value: PawnoteGradeValue | undefined): GradeValue | undefined {
  if (!value) return undefined;
  if (value.kind === 0) return { value: value.points };
  const statusByKind: Record<number, string> = {
    [-1]: "Erreur",
    1: "Absent",
    2: "Dispensé",
    3: "Non noté",
    4: "Inapte",
    5: "Non rendu",
    6: "Absent (zéro)",
    7: "Non rendu (zéro)",
    8: "Félicitations",
  };
  return { status: statusByKind[value.kind] ?? "Indisponible" };
}

function isExpiredError(error: unknown): boolean {
  return error instanceof SessionExpiredError || error instanceof BadCredentialsError;
}

class AsyncSerial {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface RealConnectorOptions {
  credentialStore: CredentialStore;
  ids: OpaqueIdService;
  documents: DocumentReader;
  logger: SafeLogger;
  dataDir: string;
}

export class RealPronoteConnector implements InteractivePronoteConnector {
  readonly #store: CredentialStore;
  readonly #ids: OpaqueIdService;
  readonly #documents: DocumentReader;
  readonly #logger: SafeLogger;
  readonly #dataDir: string;
  readonly #registry = new ReferenceRegistry();
  readonly #homework = new Map<string, Homework>();
  readonly #periods = new Map<string, PawnotePeriod>();
  readonly #serial = new AsyncSerial();
  #session: SessionHandle | null = null;
  #expired = false;

  constructor(options: RealConnectorOptions) {
    this.#store = options.credentialStore;
    this.#ids = options.ids;
    this.#documents = options.documents;
    this.#logger = options.logger;
    this.#dataDir = options.dataDir;
  }

  async connectionStatus(): Promise<PublicConnectionStatus> {
    const credential = await this.#store.get();
    return {
      connected: Boolean(credential) && !this.#expired,
      health: !credential ? "disconnected" : this.#expired ? "expired" : "connected",
      ...(credential?.establishmentName ? { establishmentName: credential.establishmentName } : {}),
      ...(credential?.className ? { className: credential.className } : {}),
      ...(credential ? { pronoteUrl: credential.pronoteUrl, lastConnectedAt: toParisIso(credential.lastConnectedAt) } : {}),
      storageBackend: this.#store.backend,
      ...(this.#store.warning ? { storageWarning: this.#store.warning } : {}),
      reconnectRequired: !credential || this.#expired,
    };
  }

  async #saveRefresh(refresh: Awaited<ReturnType<typeof loginToken>>, previous: Pick<StoredCredential, "deviceUUID">, session: SessionHandle): Promise<StoredCredential> {
    const user = session.user.resources[0];
    if (!user) throw new Error("PRONOTE_STUDENT_RESOURCE_MISSING");
    const value: StoredCredential = {
      schemaVersion: 1,
      pronoteUrl: normalizePronoteUrl(refresh.url),
      username: refresh.username,
      accountKind: "STUDENT",
      deviceUUID: previous.deviceUUID,
      token: refresh.token,
      navigatorIdentifier: refresh.navigatorIdentifier,
      establishmentName: user.establishmentName,
      ...(user.className ? { className: user.className } : {}),
      lastConnectedAt: new Date().toISOString(),
    };
    await this.#store.set(value);
    this.#expired = false;
    return value;
  }

  async #newSession(credential: StoredCredential): Promise<SessionHandle> {
    const session = createSessionHandle(pawnoteFetcher);
    try {
      const refresh = await loginToken(session, {
        url: credential.pronoteUrl,
        kind: AccountKind.STUDENT,
        username: credential.username,
        token: credential.token,
        deviceUUID: credential.deviceUUID,
        ...(credential.navigatorIdentifier ? { navigatorIdentifier: credential.navigatorIdentifier } : {}),
      });
      await this.#saveRefresh(refresh, credential, session);
      this.#session = session;
      this.#logger.info("Session PRONOTE renouvelée.", { establishment: session.user.resources[0]?.establishmentName });
      return session;
    } catch (error) {
      if (isExpiredError(error)) {
        this.#expired = true;
        throw new PronoteConnectionError("TOKEN_EXPIRED");
      }
      throw error;
    }
  }

  async #withSession<T>(operation: (session: SessionHandle) => Promise<T>): Promise<T> {
    return this.#serial.run(async () => {
      const credential = await this.#store.get();
      if (!credential) throw new PronoteConnectionError("NOT_CONNECTED");
      const session = this.#session ?? await this.#newSession(credential);
      try {
        return await operation(session);
      } catch (error) {
        if (!isExpiredError(error)) throw error;
        this.#session = null;
        try {
          const refreshedCredential = await this.#store.get();
          if (!refreshedCredential) throw new PronoteConnectionError("NOT_CONNECTED");
          return await operation(await this.#newSession(refreshedCredential));
        } catch (retryError) {
          if (isExpiredError(retryError) || retryError instanceof PronoteConnectionError) {
            this.#expired = true;
            throw new PronoteConnectionError("TOKEN_EXPIRED");
          }
          throw retryError;
        }
      }
    });
  }

  #attachments(parentId: string, attachments: readonly PawnoteAttachment[], source: "homework" | "course" | "grade"): AttachmentSummary[] {
    return attachments.map((attachment) => {
      const internalKey = `${source}\0${parentId}\0${attachment.id}`;
      const id = this.#ids.create("at", internalKey);
      const kind = attachment.kind === PawnoteAttachmentKind.File ? "file" as const : "link" as const;
      this.#registry.registerAttachment(parentId, id, {
        internalId: attachment.id,
        kind,
        name: attachment.name,
        url: attachment.url,
        source,
      });
      return { id, name: attachment.name, kind, readable: kind === "file" };
    });
  }

  async listHomework(range: DateRange): Promise<Homework[]> {
    return this.#withSession(async (session) => {
      const assignments = await assignmentsFromIntervals(session, range.from, range.to);
      const normalized = assignments.map((assignment): Homework => {
        const id = this.#ids.create("hw", assignment.id);
        const item: Homework = {
          id,
          subject: assignment.subject.name,
          description: plainText(assignment.description),
          dueAt: toParisIso(assignment.deadline),
          completed: assignment.done,
          returnType: returnType(assignment.return.kind),
          ...(assignment.length === undefined ? {} : { estimatedMinutes: assignment.length }),
          documents: this.#attachments(id, assignment.attachments, "homework"),
        };
        this.#homework.set(id, item);
        return item;
      });
      return normalized.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    });
  }

  async getHomework(id: string): Promise<Homework | null> {
    await this.#withSession(async () => undefined);
    return this.#homework.get(id) ?? null;
  }

  async getTimetable(range: DateRange): Promise<Course[]> {
    return this.#withSession(async (session) => {
      const timetable = await timetableFromIntervals(session, range.from, range.to);
      parseTimetable(session, timetable, {
        withSuperposedCanceledClasses: false,
        withCanceledClasses: true,
        withPlannedClasses: true,
      });
      const courses: Course[] = [];
      for (const entry of timetable.classes) {
        const id = this.#ids.create("co", entry.id);
        let resources: AttachmentSummary[] = [];
        if (entry.is === "lesson" && entry.lessonResourceID) {
          try {
            const lessonResource = await resource(session, entry.lessonResourceID);
            resources = lessonResource.contents.flatMap((content) => this.#attachments(id, content.files, "course"));
          } catch {
            this.#logger.warn("Ressource de cours indisponible.", { courseId: id });
          }
        }
        if (entry.is === "lesson") {
          const status = entry.status?.trim();
          courses.push({
            id,
            kind: "lesson",
            subject: entry.subject?.name ?? "Cours",
            startsAt: toParisIso(entry.startDate),
            endsAt: toParisIso(entry.endDate),
            durationMinutes: Math.max(0, Math.round((entry.endDate.getTime() - entry.startDate.getTime()) / 60_000)),
            ...(entry.classrooms.length ? { room: entry.classrooms.join(", ") } : {}),
            ...(entry.teacherNames.length ? { teacher: entry.teacherNames.join(", ") } : {}),
            ...(status ? { status } : {}),
            canceled: entry.canceled,
            modified: Boolean(status) && !entry.canceled,
            ...(entry.notes ? { notes: plainText(entry.notes) } : {}),
            resources,
          });
        } else {
          courses.push({
            id,
            kind: entry.is,
            subject: entry.title ?? (entry.is === "detention" ? "Retenue" : "Activité"),
            startsAt: toParisIso(entry.startDate),
            endsAt: toParisIso(entry.endDate),
            durationMinutes: Math.max(0, Math.round((entry.endDate.getTime() - entry.startDate.getTime()) / 60_000)),
            ...(entry.is === "detention" && entry.classrooms.length ? { room: entry.classrooms.join(", ") } : {}),
            ...(entry.is === "detention" && entry.teacherNames.length ? { teacher: entry.teacherNames.join(", ") } : {}),
            canceled: false,
            modified: false,
            ...(entry.notes ? { notes: plainText(entry.notes) } : {}),
            resources,
          });
        }
      }
      return courses.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    });
  }

  async listPeriods(): Promise<Period[]> {
    return this.#withSession(async (session) => {
      const gradeTab = session.user.resources[0]?.tabs.get(TabLocation.Grades);
      if (!gradeTab) return [];
      return gradeTab.periods.map((period) => {
        const id = this.#ids.create("pe", period.id);
        this.#periods.set(id, period);
        return { id, name: period.name, startsAt: toParisIso(period.startDate), endsAt: toParisIso(period.endDate) };
      });
    });
  }

  async getGrades(periodId: string): Promise<GradeReport> {
    return this.#withSession(async (session) => {
      if (!this.#periods.has(periodId)) {
        const tab = session.user.resources[0]?.tabs.get(TabLocation.Grades);
        for (const period of tab?.periods ?? []) this.#periods.set(this.#ids.create("pe", period.id), period);
      }
      const period = this.#periods.get(periodId);
      if (!period) throw new Error("PERIOD_NOT_FOUND");
      const overview = await gradesOverview(session, period);
      const normalizedPeriod: Period = {
        id: periodId,
        name: period.name,
        startsAt: toParisIso(period.startDate),
        endsAt: toParisIso(period.endDate),
      };
      const grades: Grade[] = overview.grades.map((grade) => {
        const id = this.#ids.create("gr", grade.id);
        const documents = this.#attachments(id, [grade.subjectFile, grade.correctionFile].filter((item): item is PawnoteAttachment => Boolean(item)), "grade");
        const classAverage = gradeValue(grade.average);
        const normalized: Grade = {
          id,
          subject: grade.subject.name,
          score: gradeValue(grade.value) ?? { status: "Indisponible" },
          outOf: gradeValue(grade.outOf) ?? { status: "Indisponible" },
          coefficient: grade.coefficient,
          ...(classAverage ? { classAverage } : {}),
          ...((grade.commentaireSurNote || grade.comment) ? { comment: plainText([grade.comment, grade.commentaireSurNote].filter(Boolean).join(" — ")) } : {}),
          date: toParisIso(grade.date),
          period: period.name,
          ...((grade.isBonus || grade.isOptional) ? { significant: false } : {}),
          documents,
        };
        return normalized;
      });
      const subjectAverages = overview.subjectsAverages.map((average) => {
        const studentAverage = gradeValue(average.student);
        const classAverage = gradeValue(average.class_average);
        const outOf = gradeValue(average.outOf);
        return {
          subject: average.subject.name,
          ...(studentAverage ? { studentAverage } : {}),
          ...(classAverage ? { classAverage } : {}),
          ...(outOf ? { outOf } : {}),
        };
      });
      const overallAverage = gradeValue(overview.overallAverage);
      const classOverallAverage = gradeValue(overview.classAverage);
      return {
        period: normalizedPeriod,
        grades,
        subjectAverages,
        ...(overallAverage ? { overallAverage } : {}),
        ...(classOverallAverage ? { classOverallAverage } : {}),
      };
    });
  }

  async listAttachments(parentId: string): Promise<AttachmentSummary[]> {
    await this.#withSession(async () => undefined);
    return this.#registry.attachmentsFor(parentId).map(({ id, reference }) => ({
      id,
      name: reference.name,
      kind: reference.kind,
      readable: reference.kind === "file",
    }));
  }

  async readAttachment(attachmentId: string, maxCharacters?: number) {
    return this.#withSession(async () => {
      const reference = this.#registry.getAttachment(attachmentId);
      if (!reference) throw new Error("ATTACHMENT_NOT_FOUND_OR_NOT_LISTED");
      const credential = await this.#store.get();
      if (!credential) throw new PronoteConnectionError("NOT_CONNECTED");
      return this.#documents.read(attachmentId, reference, credential.pronoteUrl, maxCharacters);
    });
  }

  async completeCapturedLogin(login: CapturedMobileLogin): Promise<LoginCompletion> {
    const session = createSessionHandle(pawnoteFetcher);
    const params = {
      url: normalizePronoteUrl(login.url),
      kind: AccountKind.STUDENT,
      username: login.username,
      token: login.token,
      deviceUUID: login.deviceUUID,
    } as const;
    try {
      const refresh = await loginToken(session, params);
      const credential = await this.#saveRefresh(refresh, { deviceUUID: login.deviceUUID }, session);
      this.#session = session;
      return { credential };
    } catch (error) {
      if (!(error instanceof SecurityError)) throw error;
      if (error.handle.shouldCustomPassword || error.handle.shouldCustomDoubleAuth) {
        throw new Error("UNSUPPORTED_SECURITY_CUSTOMIZATION");
      }
      return {
        credential: {
          schemaVersion: 1,
          pronoteUrl: params.url,
          username: params.username,
          accountKind: "STUDENT",
          deviceUUID: params.deviceUUID,
          token: params.token,
          lastConnectedAt: new Date().toISOString(),
        },
        pendingSecurity: {
          submitPin: async (pin: string) => {
            if (!/^\d{4}$/u.test(pin)) throw new Error("INVALID_PIN");
            const source = "PronoteConnect";
            await securitySource(session, source);
            await securitySave(session, error.handle, { pin, deviceName: source });
            const context = error.handle.context;
            const refresh = await finishLoginManually(session, context.authentication, context.identity, context.initialUsername);
            const credential = await this.#saveRefresh(refresh, { deviceUUID: login.deviceUUID }, session);
            this.#session = session;
            return credential;
          },
        },
      };
    }
  }

  async disconnect(): Promise<void> {
    this.#session = null;
    this.#expired = false;
    this.#registry.clear();
    this.#homework.clear();
    this.#periods.clear();
    await this.#store.delete();
  }

  async clearDocumentCache(): Promise<void> {
    await this.#documents.clear();
  }

  async deleteAllLocalData(): Promise<void> {
    await this.disconnect();
    await this.clearDocumentCache();
    await rm(join(this.#dataDir, "opaque-ids.key"), { force: true });
  }

  async validateInstance(value: string): Promise<InstanceValidation> {
    const normalizedUrl = normalizePronoteUrl(value);
    if (!looksLikePronoteUrl(normalizedUrl)) throw new Error("NOT_A_LIKELY_PRONOTE_URL");
    const found = await instance(normalizedUrl, pawnoteFetcher);
    const student = found.accounts.filter((account) => /eleve/iu.test(account.path));
    if (!student.length) throw new Error("STUDENT_SPACE_NOT_FOUND");
    return {
      normalizedUrl,
      name: found.name,
      casEnabled: Boolean(found.casURL || found.casToken),
      accountKinds: student.map((account) => account.name),
    };
  }

  async searchCities(query: string): Promise<CityResult[]> {
    const endpoint = new URL("https://data.geopf.fr/geocodage/search");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("limit", "10");
    const response = await fetch(endpoint, { headers: { Accept: "application/json" }, redirect: "error" });
    if (!response.ok) throw new Error("CITY_SEARCH_FAILED");
    const data = await response.json() as { features?: Array<{ properties?: Record<string, unknown>; geometry?: { coordinates?: unknown[] } }> };
    return (data.features ?? []).flatMap((feature, index) => {
      const properties = feature.properties ?? {};
      const coordinates = feature.geometry?.coordinates;
      const longitude = Number(coordinates?.[0]);
      const latitude = Number(coordinates?.[1]);
      const city = Array.isArray(properties.city) ? String(properties.city[0]) : String(properties.city ?? properties.name ?? "");
      if (!city || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
      return [{
        id: String(properties.banId ?? properties.citycode ?? `city-${index}`),
        name: city,
        context: String(properties.context ?? "France"),
        postalCode: String(properties.postcode ?? ""),
        latitude,
        longitude,
      }];
    });
  }

  async searchSchools(latitude: number, longitude: number): Promise<SchoolResult[]> {
    const schools = await geolocation({ latitude, longitude }, pawnoteFetcher);
    return schools.map((school) => ({
      name: school.name,
      url: normalizePronoteUrl(school.url),
      distanceKm: Math.round((school.distance / 1_000) * 10) / 10,
    }));
  }
}
