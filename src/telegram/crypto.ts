// Encrypts wallet keys at rest in the bot's local store. WALLET_ENCRYPTION_KEY
// is a server-side secret (set once in the server's own .env, never sent
// through Telegram) — this is a defense-in-depth layer for the store file
// itself, not a substitute for keeping that secret and the server safe.

import crypto from "crypto";

const SALT = "nft-public-mint-telegram-wallet-store"; // domain separation, not secret — the passphrase supplies the entropy
const ALGO = "aes-256-gcm";

function deriveKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, SALT, 32);
}

export function encrypt(plaintext: string, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decrypt(payload: string, passphrase: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload.");
  const key = deriveKey(passphrase);
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
