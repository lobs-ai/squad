import { timingSafeEqual } from "node:crypto";

export interface TokenGrant {
  label: string;
  scopes: string[];
  /** Set on tokens minted at runtime (e.g. via browser pairing). Static tokens
   *  read from config have this undefined. */
  ephemeral?: boolean;
}

export class Authenticator {
  private readonly byHash: Map<string, TokenGrant> = new Map();

  constructor(tokens: Array<{ label: string; secret: string; scopes: string[] }>) {
    for (const t of tokens) {
      this.byHash.set(t.secret, { label: t.label, scopes: t.scopes });
    }
  }

  /**
   * Add a runtime token (not persisted to config). Used by the browser
   * pairing flow to issue a per-browser bearer once a CLI operator has
   * approved the pairing. Returns the grant for caller convenience.
   */
  addRuntimeToken(input: { label: string; secret: string; scopes: string[] }): TokenGrant {
    const grant: TokenGrant = { label: input.label, scopes: input.scopes, ephemeral: true };
    this.byHash.set(input.secret, grant);
    return grant;
  }

  /** Drop a runtime token. Returns true when something was removed. */
  removeToken(secret: string): boolean {
    return this.byHash.delete(secret);
  }

  /**
   * Look up a grant by the raw token string. Uses constant-time comparison
   * against every configured secret to avoid timing side-channels.
   */
  verify(candidate: string | undefined): TokenGrant | null {
    if (!candidate) return null;
    const probe = Buffer.from(candidate);
    for (const [secret, grant] of this.byHash) {
      const known = Buffer.from(secret);
      if (known.length !== probe.length) continue;
      if (timingSafeEqual(known, probe)) return grant;
    }
    return null;
  }

  /**
   * Does this grant cover the given scope? Scopes use glob-style prefix match:
   * `"*"` covers everything; `"chat.*"` covers `"chat.send"`; otherwise exact.
   */
  authorized(grant: TokenGrant, scope: string): boolean {
    for (const s of grant.scopes) {
      if (s === "*") return true;
      if (s === scope) return true;
      if (s.endsWith(".*") && scope.startsWith(s.slice(0, -1))) return true;
    }
    return false;
  }
}
