import { z } from "zod/v4";

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Date attendue au format AAAA-MM-JJ");
export const OpaqueIdSchema = z.string().regex(/^[a-z]{2}_[A-Za-z0-9_-]{24,64}$/u, "Identifiant opaque invalide");

export const DateRangeInputSchema = {
  from: IsoDateSchema.describe("Premier jour inclus au format AAAA-MM-JJ, dans le fuseau Europe/Paris."),
  to: IsoDateSchema.describe("Dernier jour inclus au format AAAA-MM-JJ, dans le fuseau Europe/Paris."),
};

export const HomeworkIdInputSchema = {
  homeworkId: OpaqueIdSchema.describe("Identifiant opaque renvoyé par pronote_list_homework."),
};

export const PeriodIdInputSchema = {
  periodId: OpaqueIdSchema.describe("Identifiant opaque renvoyé par pronote_list_periods."),
};

export const AttachmentListInputSchema = {
  parentId: OpaqueIdSchema.describe("Identifiant opaque d'un devoir, cours ou note déjà renvoyé par PRONOTE."),
};

export const AttachmentReadInputSchema = {
  attachmentId: OpaqueIdSchema.describe("Identifiant opaque renvoyé par pronote_list_attachments ou dans documents."),
  maxCharacters: z.number().int().min(1_000).max(60_000).optional().describe("Limite de texte utile retourné au modèle."),
};

export const NormalizedUrlInputSchema = z.object({ url: z.string().min(1).max(2_048) }).strict();
export const CitySearchInputSchema = z.object({ query: z.string().trim().min(2).max(120) }).strict();
export const SchoolSearchInputSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
}).strict();
