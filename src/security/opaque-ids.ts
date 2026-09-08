import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { AttachmentReference } from "../domain/types.js";

type Kind = "hw" | "co" | "pe" | "gr" | "at";

export class OpaqueIdService {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.byteLength < 32) throw new Error("OPAQUE_ID_KEY_TOO_SHORT");
    this.#key = Buffer.from(key);
  }

  create(kind: Kind, internalId: string): string {
    const digest = createHmac("sha256", this.#key)
      .update(kind)
      .update("\0")
      .update(internalId)
      .digest("base64url")
      .slice(0, 32);
    return `${kind}_${digest}`;
  }
}

export async function loadOrCreateOpaqueKey(path: string): Promise<Buffer> {
  try {
    return Buffer.from(await readFile(path, "utf8"), "base64url");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, key.toString("base64url"), { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, path);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== "EEXIST") throw renameError;
      return Buffer.from(await readFile(path, "utf8"), "base64url");
    }
    return key;
  }
}

export class ReferenceRegistry {
  readonly #attachments = new Map<string, AttachmentReference>();
  readonly #parentAttachments = new Map<string, Set<string>>();

  registerAttachment(parentId: string, publicId: string, reference: AttachmentReference): void {
    this.#attachments.set(publicId, reference);
    const current = this.#parentAttachments.get(parentId) ?? new Set<string>();
    current.add(publicId);
    this.#parentAttachments.set(parentId, current);
  }

  getAttachment(id: string): AttachmentReference | undefined {
    return this.#attachments.get(id);
  }

  attachmentsFor(parentId: string): Array<{ id: string; reference: AttachmentReference }> {
    return [...(this.#parentAttachments.get(parentId) ?? [])]
      .map((id) => ({ id, reference: this.#attachments.get(id) }))
      .filter((item): item is { id: string; reference: AttachmentReference } => Boolean(item.reference));
  }

  clear(): void {
    this.#attachments.clear();
    this.#parentAttachments.clear();
  }
}
