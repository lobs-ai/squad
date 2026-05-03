import { randomUUID } from "node:crypto";
import type { ChannelHandle } from "@squad/plugin-sdk";
import type { ChannelBinding, ChannelCapabilities, ChannelRecord } from "@squad/protocol";

const DEFAULT_CAPS: ChannelCapabilities = {
  supportsPreview: false,
  supportsMultiSelect: false,
  supportsFreeText: true,
  maxOptions: 4,
  supportsImages: false,
  supportsFileUploads: false,
  supportsTaskList: false,
  supportsApprovals: false,
};

interface ChannelEntry {
  handle: ChannelHandle;
  connected: boolean;
}

export interface ChannelRegistryCallbacks {
  onChannelChanged?: (record: ChannelRecord) => void;
}

/**
 * Tracks live channel handles registered by plugins, plus the
 * session-to-channel bindings that route a session's prompts to a
 * particular remote (e.g. a Discord thread).
 *
 * The registry has no SQLite story for v1 — bindings live in process
 * memory. That matches the rest of the channel surface (which is a thin
 * wrapper around plugin-supplied handles) and keeps the contract simple.
 */
export class ChannelRegistry {
  private readonly entries: Map<string, ChannelEntry> = new Map();
  private readonly bindings: Map<string, ChannelBinding> = new Map();

  constructor(private readonly cb: ChannelRegistryCallbacks = {}) {}

  /**
   * Register a channel handle so it shows up in `channels.list`. Called for
   * every plugin-supplied handle at boot. Returns the canonical record.
   */
  add(handle: ChannelHandle, connected: boolean = false): ChannelRecord {
    this.entries.set(handle.id, { handle, connected });
    const rec = this.recordFor(handle.id)!;
    this.cb.onChannelChanged?.(rec);
    return rec;
  }

  setConnected(id: string, connected: boolean): ChannelRecord | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.connected === connected) return this.recordFor(id);
    e.connected = connected;
    const rec = this.recordFor(id)!;
    this.cb.onChannelChanged?.(rec);
    return rec;
  }

  list(): ChannelRecord[] {
    return Array.from(this.entries.keys()).map((id) => this.recordFor(id)!);
  }

  recordFor(id: string): ChannelRecord | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return {
      id: e.handle.id,
      kind: e.handle.kind ?? "channel",
      label: e.handle.label ?? e.handle.id,
      connected: e.connected,
      capabilities: this.capsFor(id),
    };
  }

  capsFor(id: string): ChannelCapabilities {
    const e = this.entries.get(id);
    if (!e?.handle.capabilities) return DEFAULT_CAPS;
    return { ...DEFAULT_CAPS, ...e.handle.capabilities };
  }

  bind(input: { channelId: string; sessionId: string; route: Record<string, unknown> }): ChannelBinding {
    if (!this.entries.has(input.channelId)) {
      throw new Error(`unknown channel: ${input.channelId}`);
    }
    const id = "cb_" + randomUUID().slice(0, 8);
    const binding: ChannelBinding = {
      id,
      channelId: input.channelId,
      sessionId: input.sessionId,
      route: input.route,
    };
    this.bindings.set(id, binding);
    return binding;
  }

  /**
   * Most-recent binding for a session, or null. Used by the runner to derive
   * a per-turn RenderContext (which channel kind the turn is rendering for).
   */
  bindingForSession(sessionId: string): ChannelBinding | null {
    for (const b of this.bindings.values()) {
      if (b.sessionId === sessionId) return b;
    }
    return null;
  }

  unbind(bindingId: string): boolean {
    return this.bindings.delete(bindingId);
  }
}
