import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

/**
 * AES-256-GCM round-trip for small secrets (OAuth tokens). The passphrase
 * can be short / human-readable; scrypt stretches it to 32 bytes.
 */
export function makeCipher(passphrase: string): {
  encrypt: (plaintext: string) => string;
  decrypt: (blob: string) => string;
} {
  const key = scryptSync(passphrase, "squad-google-auth-v1", 32);
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGO, key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
    },
    decrypt(blob: string): string {
      const parts = blob.split(":");
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error("crypto: unrecognized ciphertext format");
      }
      const [, ivB64, tagB64, ctB64] = parts;
      const iv = Buffer.from(ivB64!, "base64");
      const tag = Buffer.from(tagB64!, "base64");
      const ct = Buffer.from(ctB64!, "base64");
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    },
  };
}
