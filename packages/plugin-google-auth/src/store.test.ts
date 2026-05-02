import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuthStore } from "./store.js";

describe("GoogleAuthStore", () => {
  let tmp: string;
  let store: GoogleAuthStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "google-auth-"));
    store = new GoogleAuthStore({
      dbPath: join(tmp, "auth.db"),
      encryptionKey: "test-key-not-secret",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upserts a fresh account with default features", () => {
    const account = store.upsert({
      email: "alice@example.com",
      tokens: { access_token: "a", refresh_token: "r", expiry_date: 1 },
    });
    expect(account.email).toBe("alice@example.com");
    expect(account.features).toEqual(["calendar", "gmail", "drive"]);
    expect(store.list()).toHaveLength(1);
  });

  it("round-trips encrypted tokens", () => {
    const account = store.upsert({
      email: "alice@example.com",
      tokens: { access_token: "a", refresh_token: "r" },
    });
    const tokens = store.readTokens(account.id);
    expect(tokens.access_token).toBe("a");
    expect(tokens.refresh_token).toBe("r");
  });

  it("preserves a refresh_token across re-upserts that omit it", () => {
    const first = store.upsert({
      email: "alice@example.com",
      tokens: { access_token: "a1", refresh_token: "r1" },
    });
    store.upsert({
      email: "alice@example.com",
      tokens: { access_token: "a2" }, // refresh_token absent
    });
    const tokens = store.readTokens(first.id);
    expect(tokens.access_token).toBe("a2");
    expect(tokens.refresh_token).toBe("r1");
  });

  it("toggles which features an account exposes", () => {
    const account = store.upsert({
      email: "alice@example.com",
      tokens: { access_token: "a" },
    });
    store.setFeatures(account.id, ["calendar"]);
    expect(store.getById(account.id)?.features).toEqual(["calendar"]);
  });

  it("removes accounts cleanly", () => {
    const account = store.upsert({
      email: "alice@example.com",
      tokens: { access_token: "a" },
    });
    store.remove(account.id);
    expect(store.list()).toHaveLength(0);
  });
});
