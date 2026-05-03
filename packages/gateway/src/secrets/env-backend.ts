import type { EnvBackend } from "@squad/tools";
import type { SecretStore } from "./store.js";

/**
 * EnvBackend implementation backed by the gateway's SecretStore. The store
 * already handles persistence (mode 0600 file) and `process.env` injection,
 * so this is a thin adapter that lets the agent's env tools talk to it
 * without depending on the gateway directly.
 */
export function envBackendFor(secrets: SecretStore): EnvBackend {
  return {
    async set(name, value) {
      secrets.set(name, value);
    },
    async unset(name) {
      secrets.unset(name);
    },
    async listNames() {
      return Object.keys(secrets.list()).sort();
    },
    async has(name) {
      return secrets.has(name);
    },
  };
}
