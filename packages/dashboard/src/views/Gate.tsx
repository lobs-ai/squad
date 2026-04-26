import { useEffect, useRef, useState } from "react";

interface PairBegin {
  pairing: {
    code: string;
    label: string;
    expiresAt: string;
  };
}

interface PairPoll {
  status: "pending" | "approved" | "claimed" | "expired" | "cancelled";
  token?: string;
  label?: string;
}

type Mode = "pair" | "token";

interface Props {
  onConnect: (token: string, opts?: { remember?: boolean }) => Promise<void>;
}

/**
 * Pre-connection gate. Defaults to a "pair this browser" flow that mirrors
 * Discord's: hit `/pair/begin`, show the user a short code, poll
 * `/pair/poll` until an operator runs `squad pair browser <code>` from a
 * terminal, then connect with the freshly-minted token. Falls back to a
 * raw-token field for headless / power-user installs.
 */
export function Gate({ onConnect }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>("pair");
  const initialToken = (() => {
    try {
      return localStorage.getItem("squad-token") ?? "";
    } catch {
      return "";
    }
  })();
  const [tokenInput, setTokenInput] = useState(initialToken);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="gate">
      <h1>squad</h1>
      <div className="gate-sub">
        {mode === "pair"
          ? "pair this browser to connect — no token needed."
          : "paste your gateway bearer token to connect."}
      </div>

      {mode === "pair" ? (
        <PairFlow
          onConnect={onConnect}
          onError={setError}
          onSwitchToToken={() => setMode("token")}
          busy={busy}
          setBusy={setBusy}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await onConnect(tokenInput);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <input
            className="input"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="token"
            autoFocus
          />
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "connecting…" : "connect"}
          </button>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="link" onClick={() => setMode("pair")} style={{ fontSize: "var(--t-sm)" }}>
              ← pair this browser instead
            </span>
          </div>
        </form>
      )}
      {error && (
        <div className="hint" style={{ color: "var(--danger)", marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}

interface PairFlowProps {
  onConnect: (token: string, opts?: { remember?: boolean }) => Promise<void>;
  onError: (msg: string | null) => void;
  onSwitchToToken: () => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
}

function PairFlow({ onConnect, onError, onSwitchToToken, busy, setBusy }: PairFlowProps): JSX.Element {
  const [pairing, setPairing] = useState<PairBegin["pairing"] | null>(null);
  const [phase, setPhase] = useState<"idle" | "pending" | "approved" | "expired" | "cancelled" | "error">(
    "idle",
  );
  const [copied, setCopied] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const beginPair = async (): Promise<void> => {
    onError(null);
    setBusy(true);
    setPhase("idle");
    try {
      const label = guessLabel();
      const res = await fetch("/pair/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(`/pair/begin returned ${res.status}`);
      const body = (await res.json()) as PairBegin;
      setPairing(body.pairing);
      setPhase("pending");
      void pollLoop(body.pairing.code);
    } catch (err) {
      setPhase("error");
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pollLoop = async (code: string): Promise<void> => {
    // Poll once a second until approved/expired/cancelled or the component
    // unmounts (cancelledRef flips). Backoff is unnecessary — the gateway
    // handles the request in microseconds.
    while (!cancelledRef.current) {
      let result: PairPoll;
      try {
        const res = await fetch(`/pair/poll?code=${encodeURIComponent(code)}`);
        if (!res.ok) {
          await sleep(1500);
          continue;
        }
        result = (await res.json()) as PairPoll;
      } catch {
        await sleep(1500);
        continue;
      }
      if (cancelledRef.current) return;
      if (result.status === "approved" && result.token) {
        setPhase("approved");
        try {
          await onConnect(result.token, { remember: true });
        } catch (err) {
          setPhase("error");
          onError((err as Error).message);
        }
        return;
      }
      if (result.status === "expired") {
        setPhase("expired");
        return;
      }
      if (result.status === "cancelled") {
        setPhase("cancelled");
        return;
      }
      await sleep(1000);
    }
  };

  const copyCommand = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`squad pair browser ${code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — show the code; the user can copy by hand.
    }
  };

  if (!pairing || phase === "idle") {
    return (
      <div className="col gap-2">
        <button className="btn primary" onClick={() => void beginPair()} disabled={busy}>
          {busy ? "starting…" : "pair this browser"}
        </button>
        <div className="hint">
          you'll get a short code to approve from your terminal with{" "}
          <span className="kbd">squad pair browser ‹code›</span>.
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span
            className="link"
            onClick={onSwitchToToken}
            style={{ fontSize: "var(--t-sm)" }}
          >
            use a token instead →
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="col gap-3">
      <div
        className="mono"
        style={{
          fontSize: "var(--t-2xl)",
          letterSpacing: "0.15em",
          background: "var(--bg-inset)",
          border: "1px solid var(--accent-line)",
          borderRadius: "var(--radius)",
          padding: "12px 16px",
          textAlign: "center",
          color: "var(--accent)",
        }}
      >
        {pairing.code}
      </div>
      <div className="hint" style={{ textAlign: "center" }}>
        run this in your terminal:
      </div>
      <div
        className="row gap-2 mono"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "8px 10px",
          fontSize: "var(--t-sm)",
        }}
      >
        <span className="muted">$ </span>
        <span style={{ flex: 1 }}>squad pair browser {pairing.code}</span>
        <button className="btn ghost sm" onClick={() => void copyCommand(pairing.code)}>
          {copied ? "copied!" : "copy"}
        </button>
      </div>

      <div
        className="row gap-2 hint"
        style={{ justifyContent: "center", fontSize: "var(--t-xs)" }}
      >
        {phase === "pending" && (
          <>
            <span className="dot accent pulse" />
            <span>waiting for approval · expires {expiresIn(pairing.expiresAt)}</span>
          </>
        )}
        {phase === "approved" && (
          <>
            <span className="dot ok" />
            <span>paired — connecting…</span>
          </>
        )}
        {phase === "expired" && (
          <>
            <span className="dot warn" />
            <span>code expired</span>
          </>
        )}
        {phase === "cancelled" && (
          <>
            <span className="dot danger" />
            <span>pairing cancelled</span>
          </>
        )}
        {phase === "error" && (
          <>
            <span className="dot danger" />
            <span>something went wrong</span>
          </>
        )}
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
        <span
          className="link"
          onClick={() => {
            cancelledRef.current = true;
            setPairing(null);
            setPhase("idle");
            // Reset cancellation so a fresh pair can poll.
            setTimeout(() => {
              cancelledRef.current = false;
            }, 0);
          }}
          style={{ fontSize: "var(--t-sm)" }}
        >
          start over
        </span>
        <span className="link" onClick={onSwitchToToken} style={{ fontSize: "var(--t-sm)" }}>
          use a token instead →
        </span>
      </div>
    </div>
  );
}

function guessLabel(): string {
  // A friendly default the operator sees in `squad pair browser list`.
  // Browsers don't expose a hostname, so we synthesize from UA + locale.
  const ua = navigator.userAgent ?? "";
  let browser = "Browser";
  if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Safari")) browser = "Safari";
  let os = "";
  if (ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Linux")) os = "Linux";
  return [browser, os].filter(Boolean).join(" on ") || "Browser";
}

function expiresIn(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
  if (sec < 60) return `in ${sec}s`;
  return `in ${Math.floor(sec / 60)}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
