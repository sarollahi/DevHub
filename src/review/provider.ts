import { z } from "zod";
import type { Finding } from "./analysis";

export type ProviderResult = {
  summary: string; findings: Finding[]; confidence: number | null;
  embedding: number[] | null; costMicros: bigint; model: string; provider: string;
};
export interface ReviewModelProvider {
  analyze(metadata: string, excerpt: string): Promise<ProviderResult>;
}
const schema = z.object({
  summary: z.string().max(3000),
  confidence: z.number().min(0).max(1).optional(),
  findings: z.array(z.object({
    severity: z.enum(["INFO", "MEDIUM", "HIGH", "CRITICAL"]),
    code: z.string().max(60), message: z.string().max(600),
  })).max(20).default([]),
});
const limit = 250_000;
const readJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error("Review provider HTTP " + response.status);
  const text = await response.text();
  if (text.length > limit) throw new Error("Review provider response too large");
  return JSON.parse(text) as unknown;
};
export function createReviewProvider(): ReviewModelProvider | null {
  const endpoint = process.env.DEVHUB_REVIEW_ENDPOINT;
  const model = process.env.DEVHUB_REVIEW_MODEL;
  if (!endpoint || !model) return null;
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production"
    && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))) {
    throw new Error("Review provider must use HTTPS (HTTP loopback allowed in development)");
  }
  const embedEndpoint = process.env.DEVHUB_REVIEW_EMBEDDING_ENDPOINT;
  const embedModel = process.env.DEVHUB_REVIEW_EMBEDDING_MODEL;
  if (!!embedEndpoint !== !!embedModel) throw new Error("Review embedding endpoint and model must be configured together");
  if (embedEndpoint) {
    const url = new URL(embedEndpoint);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error("Embeddings require HTTPS");
  }
  const key = process.env.DEVHUB_REVIEW_API_KEY;
  const headers = { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) };
  const costPerMillion = Number(process.env.DEVHUB_REVIEW_USD_PER_MILLION_TOKENS ?? "0");
  if (!Number.isFinite(costPerMillion) || costPerMillion < 0) throw new Error("Invalid review provider pricing");
  const api = async (url: string, body: unknown) => readJson(await fetch(url, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(18000),
  }));
  return {
    async analyze(metadata, excerpt) {
      const includeSource = process.env.DEVHUB_REVIEW_SEND_SOURCE === "true";
      const request = {
        model, temperature: 0, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Provide a concise JSON review with summary, confidence and findings. Findings are advisory; never approve or authorize merges. Only report evidence supplied." },
          { role: "user", content: metadata.slice(0, 10000) + (includeSource ? "\nVerified content excerpts:\n" + excerpt.slice(0, 16000) : "") },
        ],
      };
      const response = await api(endpoint, request) as {
        choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number };
      };
      const content = response.choices?.[0]?.message?.content;
      if (!content || content.length > 100000) throw new Error("Malformed model response");
      const analyzed = schema.parse(JSON.parse(content));
      let vector: number[] | null = null;
      let extraTokens = 0;
      if (embedEndpoint && embedModel) {
        const embedded = await api(embedEndpoint, { model: embedModel, input: metadata.slice(0, 16000) }) as {
          data?: Array<{ embedding?: number[] }>; usage?: { total_tokens?: number };
        };
        const candidate = embedded.data?.[0]?.embedding;
        if (!candidate || !candidate.length || candidate.length > 4096 || !candidate.every(Number.isFinite)) throw new Error("Invalid provider embedding");
        vector = candidate;
        extraTokens = embedded.usage?.total_tokens ?? 0;
      }
      const tokens = (response.usage?.total_tokens ?? 0) + extraTokens;
      const price = Number.isFinite(tokens) ? BigInt(Math.max(0, Math.round(tokens * costPerMillion))) : 0n;
      // Pricing is supplied by the operator. Without it the cost remains unknown (zero).
      return {
        summary: analyzed.summary,
        findings: analyzed.findings.map(f => ({ ...f, advisory: true as const })),
        confidence: analyzed.confidence ?? null,
        embedding: vector, costMicros: price, model, provider: parsed.host,
      };
    },
  };
}
