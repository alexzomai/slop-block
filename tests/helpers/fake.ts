import type { KV } from "../../src/background/storage";

export function fakeKV(initial: Record<string, unknown> = {}): KV & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const ks = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) { Object.assign(data, structuredClone(items)); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
  };
}

export const SECRET = "sk-or-v1-SECRETSECRETSECRET9876";

export function okBody(answers: Record<string, number>) {
  return {
    id: "gen-dec-1", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe",
    answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: "noul", noul: v }])),
    usage: { cost: 0.00002, input_tokens: 100, output_tokens: 5 },
  };
}

export function resp(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}
