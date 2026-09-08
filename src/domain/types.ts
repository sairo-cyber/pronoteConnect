export type ConnectionHealth = "connected" | "disconnected" | "expired" | "error";

export interface PublicConnectionStatus {
  connected: boolean;
  health: ConnectionHealth;
  establishmentName?: string;
  className?: string;
  pronoteUrl?: string;
  lastConnectedAt?: string;
  storageBackend: "system-keyring" | "windows-dpapi" | "encrypted-local-fallback" | "memory";
  storageWarning?: string;
  reconnectRequired: boolean;
}

export interface StoredCredential {
  schemaVersion: 1;
  pronoteUrl: string;
  username: string;
  accountKind: "STUDENT";
  deviceUUID: string;
  token: string;
  navigatorIdentifier?: string;
  establishmentName?: string;
  className?: string;
  lastConnectedAt: string;
}

export type AttachmentKind = "file" | "link";

export interface AttachmentSummary {
  id: string;
  name: string;
  kind: AttachmentKind;
  readable: boolean;
}

export interface Homework {
  id: string;
  subject: string;
  description: string;
  dueAt: string;
  completed: boolean;
  returnType: "none" | "paper" | "file_upload" | "kiosk" | "audio_recording" | "unknown";
  estimatedMinutes?: number;
  documents: AttachmentSummary[];
}

export interface Course {
  id: string;
  kind: "lesson" | "activity" | "detention";
  subject: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  room?: string;
  teacher?: string;
  status?: string;
  canceled: boolean;
  modified: boolean;
  notes?: string;
  resources: AttachmentSummary[];
}

export interface Period {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface GradeValue {
  value?: number;
  status?: string;
}

export interface Grade {
  id: string;
  subject: string;
  score: GradeValue;
  outOf: GradeValue;
  coefficient: number;
  classAverage?: GradeValue;
  comment?: string;
  date: string;
  period: string;
  significant?: boolean;
  documents: AttachmentSummary[];
}

export interface SubjectAverage {
  subject: string;
  studentAverage?: GradeValue;
  classAverage?: GradeValue;
  outOf?: GradeValue;
}

export interface GradeReport {
  period: Period;
  grades: Grade[];
  subjectAverages: SubjectAverage[];
  overallAverage?: GradeValue;
  classOverallAverage?: GradeValue;
}

export interface AttachmentReadResult {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  extraction: "text" | "metadata_only" | "unsupported";
  text?: string;
  truncated: boolean;
  untrustedContent: true;
  safetyNotice: string;
}

export interface DateRange {
  from: Date;
  to: Date;
}

export interface CityResult {
  id: string;
  name: string;
  context: string;
  postalCode: string;
  latitude: number;
  longitude: number;
}

export interface SchoolResult {
  name: string;
  url: string;
  distanceKm: number;
}

export interface InstanceValidation {
  normalizedUrl: string;
  name: string;
  casEnabled: boolean;
  accountKinds: string[];
}

export interface AttachmentReference {
  internalId: string;
  kind: AttachmentKind;
  name: string;
  url: string;
  source: "homework" | "course" | "grade";
}
