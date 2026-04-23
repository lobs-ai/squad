import { timingSafeEqual } from "node:crypto";

export interface TokenGrant {
  label: string;
  scopes: string[];
}

export class Authenticator {
  private readonly byHash: Map<string, TokenGrant> = new Map();

  constructor(tokens: Array<{ label: string; secret: string; scopes: string[] }>) {
    for (const t of tokens) {
      this.byHash.set(t.secret, { label: t.label, scopes: t.scopes });
    }
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
