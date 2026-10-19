import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { updateFileLocked } from "@ian-pascoe/pi-utils/locked-file-update";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Encryption keys live outside the session, one per Secret, in a file only Pi Secret writes.
 * A Secret's ciphertext in a session can be read only while its key exists, so deleting a key at
 * the end of the Secret Lifetime, or when the Secret is forgotten, makes the session's copy
 * permanently unreadable.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

const KeyRecordSchema = Type.Object({
  key: Type.String(),
  expiresAt: Type.Number(),
});
const KeyFileSchema = Type.Object({
  version: Type.Literal(1),
  keys: Type.Record(Type.String(), KeyRecordSchema),
});
type KeyFile = Static<typeof KeyFileSchema>;

/** Session entry data holding one Secret's ciphertext; never its value or key. */
export const SealedSecretSchema = Type.Object(
  {
    version: Type.Literal(1),
    name: Type.String(),
    keyId: Type.String(),
    expiresAt: Type.Number(),
    iv: Type.String(),
    ciphertext: Type.String(),
    tag: Type.String(),
  },
  { additionalProperties: false },
);
export type SealedSecret = Static<typeof SealedSecretSchema>;

/** The key file under Pi's agent directory. */
export function keyFilePath(agentDirectory: string): string {
  return join(agentDirectory, "pi-secret", "keys.json");
}

function parseKeyFile(text: string | undefined): KeyFile {
  if (text === undefined) return { version: 1, keys: {} };
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(KeyFileSchema, parsed)) throw new Error("Pi Secret key file is malformed");
  return parsed;
}

/** Bind the ciphertext to its Secret Name, key, and expiry, so an edited entry fails to open. */
function additionalData(sealed: Pick<SealedSecret, "name" | "keyId" | "expiresAt">): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      name: sealed.name,
      keyId: sealed.keyId,
      expiresAt: sealed.expiresAt,
    }),
  );
}

/** Encryption keys for one agent directory. */
export class SecretVault {
  constructor(
    private readonly path: string,
    private readonly now: () => number,
  ) {}

  private async update(change: (file: KeyFile) => boolean): Promise<void> {
    // Force owner-only permissions on every write, even if the file was loosened since.
    await updateFileLocked(
      this.path,
      (current) => {
        const file = parseKeyFile(current);
        return change(file) ? `${JSON.stringify(file, null, 2)}\n` : undefined;
      },
      { mode: 0o600 },
    );
  }

  /** Create a key for a new Secret and return its ciphertext as session entry data. */
  async seal(name: string, value: string, expiresAt: number): Promise<SealedSecret> {
    const keyId = randomUUID();
    const key = randomBytes(KEY_BYTES);
    await this.update((file) => {
      file.keys[keyId] = { key: key.toString("base64"), expiresAt };
      return true;
    });
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(additionalData({ name, keyId, expiresAt }));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      version: 1,
      name,
      keyId,
      expiresAt,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  /** The Secret's value, or undefined once its key is gone or its lifetime has passed. */
  async open(sealed: SealedSecret): Promise<string | undefined> {
    if (sealed.expiresAt <= this.now()) return undefined;
    let text: string | undefined;
    try {
      text = await readFile(this.path, "utf8");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    }
    const record = parseKeyFile(text).keys[sealed.keyId];
    if (record === undefined || record.expiresAt <= this.now()) return undefined;
    const decipher = createDecipheriv(
      ALGORITHM,
      Buffer.from(record.key, "base64"),
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAAD(additionalData(sealed));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  /** Delete the given keys and every key whose lifetime has passed. */
  async destroy(keyIds: readonly string[]): Promise<void> {
    const now = this.now();
    await this.update((file) => {
      let changed = false;
      for (const [keyId, record] of Object.entries(file.keys)) {
        if (!keyIds.includes(keyId) && record.expiresAt > now) continue;
        Reflect.deleteProperty(file.keys, keyId);
        changed = true;
      }
      return changed;
    });
  }
}
