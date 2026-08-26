import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto";

describe("encrypt/decrypt", () => {
  it("round-trips a private key through the same passphrase", () => {
    const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff8";
    const payload = encrypt(key, "correct-horse-battery-staple");
    expect(decrypt(payload, "correct-horse-battery-staple")).toBe(key);
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const a = encrypt("same-input", "pw");
    const b = encrypt("same-input", "pw");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong passphrase", () => {
    const payload = encrypt("secret", "right-passphrase");
    expect(() => decrypt(payload, "wrong-passphrase")).toThrow();
  });

  it("fails on a tampered payload (auth tag catches it)", () => {
    const payload = encrypt("secret", "pw");
    const [iv, tag, data] = payload.split(":");
    const tampered = [iv, tag, Buffer.from("tampered!!!").toString("base64")].join(":");
    expect(() => decrypt(tampered, "pw")).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decrypt("not-a-valid-payload", "pw")).toThrow();
  });
});
