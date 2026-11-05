import { Rpc } from "@opencode/plugin/rpc"

// `scoped` marks a window that applies to one model only (its label is the model name).
export type QuotaWindow = { label: string; usedPercent: number; resetsAt: number | null; scoped?: boolean }
export type QuotaService = {
  name: string
  // Model provider ids (e.g. "openai") whose conversations this service's quota applies to.
  providers: string[]
  error?: string
  windows: QuotaWindow[]
  notes?: string[]
  // Expiry (epoch ms) of each redeemable reset, soonest first.
  resetExpiries?: number[]
  // When (epoch ms) the data was obtained; present on every successful answer.
  fetchedAt?: number
  // Set while the provider is rate limited: the time (epoch ms) before which it will not be asked again.
  retryAt?: number
}

export const Quota = Rpc.define({
  id: "quota",
  methods: {
    usage: {
      // `providers` limits the query to the services serving those model provider ids; omitted, every service is queried.
      input: {
        type: "object",
        properties: { providers: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          services: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                error: { type: "string" },
                notes: { type: "array", items: { type: "string" } },
                providers: { type: "array", items: { type: "string" } },
                resetExpiries: { type: "array", items: { type: "number" } },
                fetchedAt: { type: "number" },
                retryAt: { type: "number" },
                windows: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      usedPercent: { type: "number" },
                      resetsAt: { type: ["number", "null"] },
                      scoped: { type: "boolean" },
                    },
                    required: ["label", "usedPercent", "resetsAt"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["name", "providers", "windows"],
              additionalProperties: false,
            },
          },
        },
        required: ["services"],
        additionalProperties: false,
      },
      errors: {},
    },
  },
  events: {},
})
