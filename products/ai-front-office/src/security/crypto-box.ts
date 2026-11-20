import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export class CryptoBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, "base64");
    if (this.#key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  encrypt(value: string | null): string | null {
    if (value === null) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
  }

  decrypt(value: string | null): string | null {
    if (value === null) return null;
    const [version, ivText, tagText, encryptedText] = value.split(":");
    if (version !== "v1" || !ivText || !tagText || encryptedText === undefined) throw new Error("Unsupported encrypted payload");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  }

  hashLookup(value: string): string {
    return createHmac("sha256", this.#key).update(value.trim().toLowerCase()).digest("hex");
  }
}
