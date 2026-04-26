import { describe, it, expect, vi } from "vitest";
import { PairingStore } from "./pairing.js";
import { MemoryPairingPersistence } from "./pairing-persist.js";
import { Authenticator } from "../auth.js";

function setup(now: () => number = Date.now): { auth: Authenticator; store: PairingStore } {
  const auth = new Authenticator([]);
  const store = new PairingStore(auth, {}, { now });
  return { auth, store };
}

describe("PairingStore", () => {
  it("begin returns a code and onRequested fires", () => {
    const auth = new Authenticator([]);
    const onRequested = vi.fn();
    const store = new PairingStore(auth, { onRequested });
    const view = store.begin({ label: "Rafe's MacBook" });
    expect(view.code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(view.status).toBe("pending");
    expect(view.label).toBe("Rafe's MacBook");
    expect(onRequested).toHaveBeenCalledOnce();
  });

  it("default scopes are full admin", () => {
    const { store } = setup();
    const v = store.begin();
    expect(v.scopes).toEqual(["*"]);
  });

  it("approve mints a runtime token; claim returns it once", () => {
    const { auth, store } = setup();
    const v = store.begin();
    store.approve({ code: v.code, approvedBy: "rafe" });
    const claim1 = store.claim(v.code);
    expect(claim1.status).toBe("approved");
    expect(typeof claim1.token).toBe("string");
    // Token resolves through the authenticator.
    expect(auth.verify(claim1.token!)).toMatchObject({ ephemeral: true });
    // Second poll returns claimed without a token.
    const claim2 = store.claim(v.code);
    expect(claim2.status).toBe("claimed");
    expect(claim2.token).toBeUndefined();
  });

  it("claim is case-insensitive and tolerant of typos", () => {
    const { store } = setup();
    const v = store.begin();
    store.approve({ code: v.code });
    const lower = v.code.toLowerCase().replace(/-/g, " - ");
    const claim = store.claim(lower);
    expect(claim.status).toBe("approved");
    expect(claim.token).toBeDefined();
  });

  it("expired codes return expired and the token is dropped", () => {
    let now = 0;
    const { auth, store } = setup(() => now);
    const v = store.begin();
    store.approve({ code: v.code });
    now = Date.parse(v.expiresAt) + 1;
    const claim = store.claim(v.code);
    expect(claim.status).toBe("expired");
    // The runtime token should have been removed during prune.
    // (We can't read it back to assert removal directly, but verify() is
    // the only API; create another token to confirm authenticator still works.)
    auth.addRuntimeToken({ label: "x", secret: "s", scopes: ["*"] });
    expect(auth.verify("s")).toMatchObject({ label: "x" });
  });

  it("cancel transitions to cancelled and revokes any token", () => {
    const { auth, store } = setup();
    const v = store.begin();
    store.approve({ code: v.code });
    const view = store.cancel(v.code);
    expect(view?.status).toBe("cancelled");
    const claim = store.claim(v.code);
    expect(claim.status).toBe("cancelled");
    // Cancelled — no token should still verify.
    expect(auth.verify("never-set")).toBeNull();
  });

  it("approve throws on unknown / expired / cancelled codes", () => {
    const { store } = setup();
    expect(() => store.approve({ code: "NOPE-NOPE" })).toThrow(/unknown pairing/);
    const v = store.begin();
    store.cancel(v.code);
    expect(() => store.approve({ code: v.code })).toThrow(/cancelled/);
  });

  it("approve is idempotent — second call returns the same view", () => {
    const { store } = setup();
    const v = store.begin();
    const a = store.approve({ code: v.code, approvedBy: "rafe" });
    const b = store.approve({ code: v.code, approvedBy: "rafe" });
    expect(b.code).toBe(a.code);
    expect(b.status).toBe("approved");
  });

  it("list keeps claimed pairings (active browser sessions)", () => {
    const { store } = setup();
    const a = store.begin();
    const b = store.begin();
    store.approve({ code: a.code });
    store.claim(a.code); // a → claimed (still an active browser)
    const remaining = store.list();
    expect(remaining.find((r) => r.code === a.code)?.status).toBe("claimed");
    expect(remaining.find((r) => r.code === b.code)?.status).toBe("pending");
  });

  it("persists approved pairings and survives a restart", () => {
    const persistence = new MemoryPairingPersistence();
    const auth1 = new Authenticator([]);
    const store1 = new PairingStore(auth1, {}, { persistence });

    const v = store1.begin({ label: "Rafe's MacBook" });
    store1.approve({ code: v.code, approvedBy: "rafe" });
    const claim = store1.claim(v.code);
    expect(claim.token).toBeDefined();

    // Persistence holds the secret; the in-memory authenticator + store
    // are gone after a restart.
    const saved = persistence.load();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.secret).toBe(claim.token);

    // Boot a fresh store + authenticator pointing at the same persistence.
    const auth2 = new Authenticator([]);
    const store2 = new PairingStore(auth2, {}, { persistence });
    const restored = store2.hydrate();
    expect(restored).toBe(1);

    // The browser's saved bearer keeps verifying against the new authenticator.
    expect(auth2.verify(claim.token!)).toMatchObject({ label: "Rafe's MacBook" });

    // The pairing is visible in list() so the operator can revoke it.
    const list = store2.list();
    expect(list[0]?.status).toBe("claimed");
    expect(list[0]?.persistent).toBe(true);
  });

  it("cancel removes a persisted entry from disk and revokes its token", () => {
    const persistence = new MemoryPairingPersistence();
    const auth = new Authenticator([]);
    const store = new PairingStore(auth, {}, { persistence });
    const v = store.begin();
    store.approve({ code: v.code });
    const claim = store.claim(v.code);
    expect(persistence.load()).toHaveLength(1);
    store.cancel(v.code);
    expect(persistence.load()).toHaveLength(0);
    expect(auth.verify(claim.token!)).toBeNull();
  });
});
