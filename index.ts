import { Plugin } from "@opencode/plugin"
import { Quota, type QuotaService, type QuotaWindow } from "./rpc.js"

type QuotaFetch = { windows: QuotaWindow[]; notes?: string[]; resetExpiries?: number[] }

// A provider the plugin knows how to query. `credentials` returns undefined when the user has none,
// in which case the provider is skipped silently; any other failure is shown under its name.
// To add a provider, append an entry to PROVIDERS. Every window must be normalised to "used" percent.
type Provider<C = any> = {
  name: string
  // Model provider ids this quota applies to, so a UI can pick the service for the current model.
  providers: string[]
  credentials(ctx: PluginContext): Promise<C | undefined>
  fetch(credentials: C, debug: boolean): Promise<QuotaFetch | QuotaWindow[]>
}

type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

// The usage endpoints are unofficial and rate limit; the wait they ask for is honoured per provider.
class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("rate limited")
  }
}
const DEFAULT_RETRY_MS = 5 * 60_000
// The wait a provider asks for is stretched by this factor, to stay clear of its limit.
const RETRY_MARGIN = 1.1
const CACHE_MS = 60_000

// Development aid: the last answer of each endpoint, with every string replaced except timestamps and a
// few labels (no emails or ids), plus the rate limit headers of any 429, so shapes can be inspected offline.
const SAMPLES_DIR = "/tmp/quota-samples"
const KEEP_STRINGS = new Set(["kind", "group", "status", "severity", "model", "surface", "plan_type", "currency", "display_name"])

function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return KEEP_STRINGS.has(key) || /^\d{4}-\d\d-\d\dT/.test(value) ? value : "<string>"
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  }
  return value
}

async function capture(debug: boolean, url: string, suffix: string, data: unknown): Promise<void> {
  if (!debug) return
  try {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const target = new URL(url)
    const name = `${target.hostname}${target.pathname}`.replace(/\W+/g, "_").replace(/^_|_$/g, "")
    await mkdir(SAMPLES_DIR, { recursive: true })
    await writeFile(`${SAMPLES_DIR}/${name}${suffix}.json`, JSON.stringify(data, null, 1))
  } catch {}
}

// Development aid: every request made to an endpoint, every call to the plugin and every request skipped
// because of a block, one line each and never overwritten, to find how often the endpoints can be asked.
async function log(debug: boolean, line: string): Promise<void> {
  if (!debug) return
  try {
    const { mkdir, appendFile } = await import("node:fs/promises")
    await mkdir(SAMPLES_DIR, { recursive: true })
    await appendFile(`${SAMPLES_DIR}/requests.log`, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

async function getJson(url: string, headers: Record<string, string>, debug: boolean): Promise<any> {
  const target = new URL(url)
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  const retryAfter = response.headers.get("retry-after")
  await log(debug, `request ${target.hostname}${target.pathname} -> ${response.status}${retryAfter ? ` retry-after=${retryAfter}` : ""}`)
  if (response.status === 429) {
    const limitHeaders = [...response.headers].filter(([name]) => /retry|limit|reset|remaining|^date$/i.test(name))
    await capture(debug, url, ".429", { status: 429, headers: Object.fromEntries(limitHeaders) })
    await log(debug, `429 headers ${JSON.stringify(Object.fromEntries(limitHeaders))}`)
    const seconds = Number(retryAfter)
    const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS
    throw new RateLimited(Math.ceil(asked * RETRY_MARGIN))
  }
  if (response.status === 401 || response.status === 403) throw new Error("token expired or insufficient permissions")
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error("unrecognized response")
  }
  if (debug) await capture(debug, url, "", redact(body))
  return body
}

const isoToMs = (value: unknown) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? null : ms
}

// Fail loudly on an unexpected shape instead of showing a made-up 0%.
function percent(value: unknown): number {
  if (typeof value !== "number") throw new Error("unrecognized response")
  return value
}

// The credential OpenCode holds for an integration, or undefined when none is connected.
async function integrationCredential(ctx: PluginContext, id: string): Promise<any | undefined> {
  let connection
  try {
    connection = await ctx.integration.connection.active(id)
  } catch {
    return undefined
  }
  if (!connection) return undefined
  return ctx.integration.connection.resolve(connection)
}

function modelName(scope: any): string {
  const model = scope?.model
  if (typeof model === "string") return model
  return model?.display_name ?? model?.name ?? model?.id ?? "model"
}

// Banked resets the user can redeem at any time; best effort, the quota windows must not depend on it.
async function openaiResets(headers: Record<string, string>, debug: boolean): Promise<{ notes: string[]; expiries?: number[] }> {
  try {
    const body = await getJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
      ...headers,
      originator: "Codex Desktop",
      "oai-product-sku": "CODEX",
      accept: "application/json",
    }, debug)
    const available = (Array.isArray(body?.credits) ? body.credits : []).filter(
      (credit: any) => String(credit?.status ?? "").toLowerCase() === "available",
    )
    const count = typeof body?.available_count === "number" ? body.available_count : available.length
    const expiries: number[] = available
      .map((credit: any) => {
        const raw = credit?.expires_at
        return typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : isoToMs(raw)
      })
      .filter((ms: number | null): ms is number => ms !== null)
      .sort((a: number, b: number) => a - b)
    // Environment time zone (no hardcoded CET); the zone abbreviation is shown so it is unambiguous.
    const format = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
    return { notes: [`resets: ${count}`, ...expiries.map((ms) => `· expires ${format.format(ms)}`)], expiries }
  } catch (error) {
    return { notes: [`resets: could not load (${error instanceof Error ? error.message : "error"})`] }
  }
}

const PROVIDERS: Provider[] = [
  {
    name: "Claude",
    providers: ["claude-agent", "anthropic"],
    // Claude Code's own login; OpenCode's claude-agent integration exposes no token.
    async credentials() {
      const { readFile } = await import("node:fs/promises")
      const { homedir } = await import("node:os")
      try {
        const raw = JSON.parse(await readFile(`${homedir()}/.claude/.credentials.json`, "utf8"))
        const token = raw?.claudeAiOauth?.accessToken
        return typeof token === "string" ? token : undefined
      } catch {
        return undefined
      }
    },
    async fetch(token: string, debug) {
      const body = await getJson("https://api.anthropic.com/api/oauth/usage", {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      }, debug)
      if (!Array.isArray(body?.limits)) throw new Error("unrecognized response")
      return body.limits.flatMap((limit: any): QuotaWindow[] => {
        const label =
          limit.kind === "session" ? "5h" : limit.kind === "weekly_all" ? "weekly" : limit.kind === "weekly_scoped" ? modelName(limit.scope) : undefined
        if (!label) return []
        const scoped = limit.kind === "weekly_scoped"
        return [{ label, usedPercent: percent(limit.percent), resetsAt: isoToMs(limit.resets_at), ...(scoped ? { scoped } : {}) }]
      })
    },
  },
  {
    name: "OpenAI",
    providers: ["openai"],
    credentials: (ctx) => integrationCredential(ctx, "openai"),
    async fetch({ access, metadata }, debug) {
      const headers = {
        authorization: `Bearer ${access}`,
        ...(metadata?.accountID ? { "chatgpt-account-id": String(metadata.accountID) } : {}),
      }
      const body = await getJson("https://chatgpt.com/backend-api/wham/usage", headers, debug)
      const rate = body?.rate_limit
      const windows = [
        ["5h", rate?.primary_window],
        ["weekly", rate?.secondary_window],
      ].map(([label, w]: any) => ({
        label,
        usedPercent: percent(w?.used_percent),
        resetsAt: typeof w?.reset_at === "number" ? w.reset_at * 1000 : null,
      }))
      const resets = await openaiResets(headers, debug)
      return { windows, notes: resets.notes, resetExpiries: resets.expiries }
    },
  },
  {
    name: "OpenCode Go",
    // Not "opencode": that provider serves the free and pay-as-you-go Zen models, which this quota does not cover.
    providers: ["opencode-go"],
    credentials: (ctx) => integrationCredential(ctx, "opencode"),
    async fetch({ access }, debug) {
      const body = await getJson("https://opencode.ai/zen/go/v1/usage", { authorization: `Bearer ${access}` }, debug)
      const usage = body?.usage
      return [
        ["5h", usage?.rolling],
        ["weekly", usage?.weekly],
        ["monthly", usage?.monthly],
      ].map(([label, w]: any) => ({ label, usedPercent: percent(w?.percent), resetsAt: isoToMs(w?.resetsAt) }))
    },
  },
]

// undefined means "skip": the user has no credentials for this provider.
// Last good answer per provider (it carries its own `fetchedAt`) and the time each one is blocked until.
// Every caller (top line, sidebar, /quota) goes through `query`, so a block set by one is honoured by all.
const cache = new Map<string, QuotaService>()
const blockedUntil = new Map<string, number>()
const inflight = new Map<string, Promise<QuotaService>>()

// While a provider is rate limited: its last good data, or an error when there is none, and when it can be asked again.
function whileLimited(provider: Provider, until: number): QuotaService {
  const cached = cache.get(provider.name)
  if (!cached) {
    return { name: provider.name, providers: provider.providers, windows: [], error: "rate limited", retryAt: until }
  }
  return { ...cached, retryAt: until }
}

async function query(provider: Provider, ctx: PluginContext, debug: boolean): Promise<QuotaService | undefined> {
  try {
    const credentials = await provider.credentials(ctx)
    if (credentials === undefined) return undefined
    const cached = cache.get(provider.name)
    if (cached?.fetchedAt !== undefined && Date.now() - cached.fetchedAt < CACHE_MS) return cached
    const until = blockedUntil.get(provider.name) ?? 0
    if (until > Date.now()) {
      await log(debug, `skip ${provider.name}: blocked for ${Math.round((until - Date.now()) / 1000)}s more`)
      return whileLimited(provider, until)
    }
    // Calls that arrive while a request is out share it, so a burst makes one request at most.
    let pending = inflight.get(provider.name)
    if (!pending) {
      pending = (async () => {
        const result = await provider.fetch(credentials, debug)
        const base = { name: provider.name, providers: provider.providers, fetchedAt: Date.now() }
        const service: QuotaService = Array.isArray(result) ? { ...base, windows: result } : { ...base, ...result }
        cache.set(provider.name, service)
        blockedUntil.delete(provider.name)
        return service
      })().finally(() => inflight.delete(provider.name))
      inflight.set(provider.name, pending)
    }
    return await pending
  } catch (error) {
    if (error instanceof RateLimited) {
      const until = Date.now() + error.retryAfterMs
      blockedUntil.set(provider.name, until)
      await log(debug, `block ${provider.name} until ${new Date(until).toISOString()}`)
      return whileLimited(provider, until)
    }
    return { name: provider.name, providers: provider.providers, windows: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export default Plugin.define({
  id: "quota",
  async setup(ctx) {
    const debug = ctx.options.debug === true || process.env.OPENCODE_QUOTA_DEBUG === "1"
    await ctx.rpc.register(Quota, {
      usage: async (request: any) => {
        // Only the services for the requested model providers, or all of them when none are named.
        const wanted: string[] | undefined = (request?.input ?? request)?.providers
        const selected = wanted ? PROVIDERS.filter((provider) => provider.providers.some((id) => wanted.includes(id))) : PROVIDERS
        await log(debug, `rpc usage ${wanted ? wanted.join(",") : "all"}`)
        const results = await Promise.all(selected.map((provider) => query(provider, ctx, debug)))
        return { services: results.filter((service): service is QuotaService => service !== undefined) }
      },
    })
  },
})
