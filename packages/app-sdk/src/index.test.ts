import { describe, it, expect, afterEach } from "vitest";
import { createApp, wrap } from "./index.js";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";

const open: Array<HttpServer | { stop: () => Promise<void> }> = [];

afterEach(async () => {
  for (const h of open.splice(0)) {
    if ("stop" in h) await h.stop();
    else await new Promise<void>((r) => h.close(() => r()));
  }
});

async function fetchText(url: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("createApp", () => {
  it("auto-mounts /squad/info and /squad/health and serves user routes", async () => {
    const app = createApp({
      name: "weather",
      title: "Weather",
      description: "shows weather",
      version: "1.2.3",
    });
    app.get("/", (_req, res) => res.send("<h1>Hi</h1>"));
    app.get("/api/forecast", (_req, res) => res.json({ days: 5 }));
    const { port } = await app.start();
    open.push(app);

    const health = await fetchText(`http://127.0.0.1:${port}/squad/health`);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });

    const info = await fetchText(`http://127.0.0.1:${port}/squad/info`);
    expect(info.status).toBe(200);
    const parsed = JSON.parse(info.body);
    expect(parsed.name).toBe("weather");
    expect(parsed.title).toBe("Weather");
    expect(parsed.description).toBe("shows weather");
    expect(parsed.version).toBe("1.2.3");
    expect(typeof parsed.pid).toBe("number");

    const root = await fetchText(`http://127.0.0.1:${port}/`);
    expect(root.body).toBe("<h1>Hi</h1>");
    expect(root.headers.get("content-type")).toContain("text/html");

    const api = await fetchText(`http://127.0.0.1:${port}/api/forecast`);
    expect(JSON.parse(api.body)).toEqual({ days: 5 });

    const miss = await fetchText(`http://127.0.0.1:${port}/nope`);
    expect(miss.status).toBe(404);
  });

  it("supports path params with :name segments", async () => {
    const app = createApp({ name: "users", title: "Users" });
    app.get("/users/:id", (_req, res, ctx) => res.json({ id: ctx.params["id"] }));
    const { port } = await app.start();
    open.push(app);

    const r = await fetchText(`http://127.0.0.1:${port}/users/abc`);
    expect(JSON.parse(r.body)).toEqual({ id: "abc" });
  });

  it("rejects bad names at construction time", () => {
    expect(() => createApp({ name: "Bad Name", title: "x" })).toThrow();
    expect(() => createApp({ name: "_under", title: "x" })).toThrow();
    expect(() => createApp({ name: "ok", title: "" })).toThrow(/title is required/);
  });
});

describe("wrap", () => {
  it("decorates an existing http.Server with /squad/* without losing the user handler", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`got ${req.url}`);
    });
    open.push(server);
    const { port } = await wrap(server, { name: "wrapped", title: "Wrapped" });

    const health = await fetchText(`http://127.0.0.1:${port}/squad/health`);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });

    const info = await fetchText(`http://127.0.0.1:${port}/squad/info`);
    expect(JSON.parse(info.body).name).toBe("wrapped");

    const passthrough = await fetchText(`http://127.0.0.1:${port}/anything`);
    expect(passthrough.body).toBe("got /anything");
  });
});
