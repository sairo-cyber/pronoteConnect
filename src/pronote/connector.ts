import type {
  AttachmentReadResult,
  AttachmentSummary,
  CityResult,
  Course,
  DateRange,
  GradeReport,
  Homework,
  InstanceValidation,
  Period,
  PublicConnectionStatus,
  SchoolResult,
  StoredCredential,
} from "../domain/types.js";

export class PronoteConnectionError extends Error {
  constructor(readonly code: "NOT_CONNECTED" | "TOKEN_EXPIRED" | "LOGIN_REQUIRED" | "PRONOTE_UNAVAILABLE") {
    super(code);
    this.name = "PronoteConnectionError";
  }
}

export interface BrowserLoginState {
  phase: "idle" | "opening_browser" | "waiting_for_user" | "exchanging_token" | "waiting_for_pin" | "success" | "error";
  message: string;
  pinRequired: boolean;
}

export interface CapturedMobileLogin {
  url: string;
  username: string;
  token: string;
  deviceUUID: string;
}

export interface LoginCompletion {
  credential: StoredCredential;
  pendingSecurity?: {
    submitPin(pin: string): Promise<StoredCredential>;
  };
}

export interface PronoteConnector {
  connectionStatus(): Promise<PublicConnectionStatus>;
  listHomework(range: DateRange): Promise<Homework[]>;
  getHomework(id: string): Promise<Homework | null>;
  getTimetable(range: DateRange): Promise<Course[]>;
  listPeriods(): Promise<Period[]>;
  getGrades(periodId: string): Promise<GradeReport>;
  listAttachments(parentId: string): Promise<AttachmentSummary[]>;
  readAttachment(attachmentId: string, maxCharacters?: number): Promise<AttachmentReadResult>;
  disconnect(): Promise<void>;
  clearDocumentCache(): Promise<void>;
  deleteAllLocalData(): Promise<void>;
  validateInstance(url: string): Promise<InstanceValidation>;
  searchCities(query: string): Promise<CityResult[]>;
  searchSchools(latitude: number, longitude: number): Promise<SchoolResult[]>;
}

export interface InteractivePronoteConnector extends PronoteConnector {
  completeCapturedLogin(login: CapturedMobileLogin): Promise<LoginCompletion>;
}
