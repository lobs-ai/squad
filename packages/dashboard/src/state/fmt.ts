export function fmtAgo(input: string | number | Date | null | undefined, now: number = Date.now()): string {
  if (input == null) return "—";
  const t = typeof input === "string" ? Date.parse(input) : typeof input === "number" ? input : input.getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return "now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86_400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86_400) + "d ago";
}

export function fmtTokens(n: number | undefined | null): string {
  if (!n || n < 1000) return String(n ?? 0);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

/**
 * Cost estimation is intentionally narrow. We can only honestly price a
 * call when the model id matches one of the providers we've negotiated
 * pricing for; everything else returns null and the UI shows a dash.
 *
 * If/when the gateway grows real provider-side billing data, replace this
 * with a request to that endpoint and delete the table below.
 */
const PRICING: Record<string, [number, number]> = {
  // Anthropic — public list price, $/Mtok (input, output)
  "anthropic/claude-opus-4-5": [15, 75],
  "anthropic/claude-sonnet-4-5": [3, 15],
  "anthropic/claude-haiku-4-5": [0.8, 4],
  "anthropic/claude-3-5-sonnet-20241022": [3, 15],
  // OpenAI
  "openai/gpt-4o": [2.5, 10],
  "openai/gpt-4o-mini": [0.15, 0.6],
  "openai/gpt-4.1": [3, 12],
  "openai/o1": [15, 60],
  "openai/o3-mini": [1.1, 4.4],
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number | null {
  const tier = PRICING[model] ?? PRICING[stripProvider(model)];
  if (!tier) return null;
  const [inP, outP] = tier;
  return (tokensIn / 1_000_000) * inP + (tokensOut / 1_000_000) * outP;
}

function stripProvider(model: string): string {
  // Some sessions store the bare model id; others prefix with provider/.
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.01) return "$0.00";
  return "$" + usd.toFixed(2);
}

export function shortId(id: string, take: number = 6): string {
  return id.slice(-take);
}

export function modelShort(model: string): string {
  return model.replace(/^anthropic\//, "").replace(/^openai\//, "").replace(/^google\//, "")
    .replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
}

export function modelFamily(model: string): string {
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus")) return "opus";
  if (model.includes("gpt")) return "gpt";
  if (model.includes("gemini")) return "gemini";
  if (model.includes("llama")) return "llama";
  if (model.includes("mistral") || model.includes("codestral")) return "mistral";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("qwen")) return "qwen";
  if (model.includes("grok")) return "grok";
  return model.split(/[-_/]/)[0] ?? model;
}
