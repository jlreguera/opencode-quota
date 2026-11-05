/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Quota, type QuotaService } from "./rpc.js"

// Where the per-model quota goes: the line right above the prompt box. The line inside the box that
// holds agent, model and provider is not an exposed slot, and "prompt.footer" lands on the bottom row.
const FOOTER_SLOT = "session.composer.top"
// The quota endpoints are unofficial and rate limit, so each provider's data is refreshed lazily (when a turn
// ends or the TUI starts, only for the current model's provider), never on a timer.
const TTL_MS = 10 * 60_000
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const SHORT: Record<string, string> = { weekly: "wk", monthly: "mo" }

type Part = { text: string; fg: string; bg?: string }

// Used percent from which a window moves up a level: success -> warning -> in between -> error.
const WARNING_AT = 70
const HIGH_AT = 90
const DANGER_AT = 95
// Used only when the theme lacks the token (colors come from the theme's text.feedback.*.base).
const FEEDBACK_FALLBACK = { success: "#7fd88f", warning: "#f5a742", error: "#e06c75" }

const BAR_WIDTH = 10

const Parts = (parts: Part[]) =>
  parts.map((part) => (
    <text fg={part.fg} bg={part.bg}>
      {part.text}
    </text>
  ))

function eta(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null) return "-"
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d${hours}h`
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`
}

// Shown while a provider is rate limited: when its data is from and how long until it is asked again.
function limitNote(service: QuotaService, now: number): string | undefined {
  if (service.retryAt === undefined) return undefined
  const parts = [service.fetchedAt === undefined ? "no data" : `data from ${clock.format(service.fetchedAt)}`]
  if (service.retryAt > now) parts.push(`retry in ${eta(service.retryAt, now)}`)
  return parts.join(" · ")
}

// Errors from the client are tagged objects, not Error instances: String() gives "[object Error]".
function describe(error: unknown): string {
  const e = error as { message?: unknown; _tag?: unknown; type?: unknown }
  if (typeof e?.message === "string") return [e._tag, e.type, e.message].filter((x) => typeof x === "string").join(" ")
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export default Plugin.define({
  id: "quota.tui",
  setup(context) {
    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { show: true, resetAlertHours: 6 },
    })
    // Whether the sidebar block is mounted, i.e. the sidebar is open. Only the top line reads it.
    const [ui, updateUi] = context.storage.memory("ui", { initial: { sidebar: false } })
    // Used to notice the sidebar closing; if it cannot be loaded the sidebar is never reported as open.
    let onCleanup: ((fn: () => void) => void) | undefined
    import("solid-js").then((solid) => void (onCleanup = solid.onCleanup)).catch(() => {})
    // Older stores have no `show`; it counts as on.
    const showQuota = () => settings.show !== false
    const [state, updateState] = context.storage.memory("state", {
      initial: { services: [] as QuotaService[], fetchedAt: {} as Record<string, number>, now: Date.now() },
    })

    // Newer answers replace the service of the same name; the others keep their last data.
    const merge = (services: QuotaService[], providerIds: string[]) =>
      updateState((draft) => {
        draft.services = [...state.services.filter((old) => !services.some((s) => s.name === old.name)), ...services]
        draft.fetchedAt = { ...state.fetchedAt, ...Object.fromEntries(providerIds.map((id) => [id, Date.now()])) }
      })

    const inflight = new Set<string>()
    // Asks only for the service of one model provider (the current model's by default), and not before its data
    // is older than TTL_MS or while the service says it is rate limited.
    const refresh = async (providerId = modelRef().provider) => {
      if (!providerId || inflight.has(providerId)) return
      if (Date.now() - (state.fetchedAt[providerId] ?? 0) < TTL_MS) return
      const known = state.services.find((s) => s.providers.includes(providerId))
      if (known?.retryAt !== undefined && known.retryAt > Date.now()) return
      inflight.add(providerId)
      try {
        const { services } = await context.client.rpc(Quota).usage({ providers: [providerId] })
        merge(services, [providerId])
      } catch {
        // The footer stays as it was; /quota shows errors.
      } finally {
        inflight.delete(providerId)
      }
    }

    // The model's provider id and model id, read defensively as the selected-model shape is not documented.
    const modelRef = () => {
      const selected = context.ui.model.current() as any
      return {
        provider: String(selected?.providerID ?? selected?.provider?.id ?? selected?.provider ?? ""),
        model: String(selected?.modelID ?? selected?.id ?? ""),
        name: String(selected?.name ?? ""),
      }
    }

    // Theme colors are RGBA objects whose channels are 0-255 (or 0-1); convert them to "#rrggbb".
    const hex = (value: unknown): string | undefined => {
      if (typeof value === "string") return value
      const buffer = (value as any)?.buffer
      if (!buffer) return undefined
      const channels = [buffer[0], buffer[1], buffer[2]] as number[]
      if (channels.some((channel) => typeof channel !== "number")) return undefined
      const scale = Math.max(...channels) <= 1 ? 255 : 1
      return "#" + channels.map((channel) => Math.round(channel * scale).toString(16).padStart(2, "0")).join("")
    }
    const themed = (path: string[], fallback: string): string => {
      let value: any = context.theme
      for (const key of path) value = value?.[key]
      return hex(value) ?? fallback
    }
    const mix = (a: string, b: string): string => {
      const channel = (color: string, index: number) => parseInt(color.slice(1 + index * 2, 3 + index * 2), 16)
      return "#" + [0, 1, 2].map((i) => Math.round((channel(a, i) + channel(b, i)) / 2).toString(16).padStart(2, "0")).join("")
    }
    const feedback = (name: keyof typeof FEEDBACK_FALLBACK) => themed(["text", "feedback", name, "base"], FEEDBACK_FALLBACK[name])
    // Color of a window by used percent; the step between warning and error is a blend of the two.
    const colorFor = (percent: number) =>
      percent >= DANGER_AT
        ? feedback("error")
        : percent >= HIGH_AT
          ? mix(feedback("warning"), feedback("error"))
          : percent >= WARNING_AT
            ? feedback("warning")
            : feedback("success")
    const textColor = () => themed(["text", "base"], "#ffffff")
    const mutedColor = () => themed(["text", "muted"], "#8a8a8a")
    const trackColor = () => themed(["background", "raised", "max"], "#4a4a4a")

    // "32%" centered in the bar width, drawn white over a gray track with the used part filled in the level color.
    const barParts = (percent: number, width = BAR_WIDTH): Part[] => {
      const label = `${Math.round(percent)}%`
      const padded = " ".repeat(Math.floor((width - label.length) / 2)) + label
      const text = padded.padEnd(width)
      const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
      return [
        { text: text.slice(0, filled), fg: textColor(), bg: colorFor(percent) },
        { text: text.slice(filled), fg: textColor(), bg: trackColor() },
      ].filter((part) => part.text.length > 0)
    }

    // Quota of the current conversation's model: only the windows the user enabled, nothing when unknown or failing.
    // Each window is drawn in a single level color (name, bar and reset time) so it reads as one unit.
    const footerParts = (): Part[] => {
      // With the sidebar open the same data is shown there, so the top line steps aside.
      if (!showQuota() || ui.sidebar) return []
      const { provider, model, name } = modelRef()
      const service = state.services.find((s) => s.providers.includes(provider))
      // A rate limited service still shows its last data (or just the wait); any other error shows nothing.
      if (!service || (service.error && service.retryAt === undefined)) return []
      const now = state.now
      const parts: Part[] = []
      const separator = () => parts.push({ text: "  ·  ", fg: mutedColor() })
      // A window for one model (e.g. "Fable") shows when the selected model's id or name contains it, any case.
      const selected = `${model} ${name}`.toLowerCase()
      service.windows
        .filter((w) => !w.scoped || selected.includes(w.label.toLowerCase()))
        .forEach((w, index) => {
          if (index > 0) separator()
          const fg = colorFor(w.usedPercent)
          parts.push({ text: `${SHORT[w.label] ?? w.label} `, fg }, ...barParts(w.usedPercent), {
            text: ` ${eta(w.resetsAt, now)}`,
            fg,
          })
        })
      const note = limitNote(service, now)
      if (note) {
        if (parts.length > 0) separator()
        parts.push({ text: note, fg: feedback("warning") })
      }
      const alertMs = settings.resetAlertHours * 3_600_000
      if (alertMs > 0) {
        const next = service.resetExpiries?.find((ms) => ms > now)
        if (next !== undefined && next - now < alertMs) {
          if (parts.length > 0) separator()
          parts.push({ text: `reset expires in ${eta(next, now)}`, fg: feedback("warning") })
        }
      }
      return parts.length > 0 ? [{ text: "  ", fg: mutedColor() }, ...parts] : []
    }

    // One provider's block: the title in the text color so it stands out, then each window in its level color.
    // Elements can only be created while rendering, so this is called from inside a render callback.
    const serviceBlock = (service: QuotaService, labelWidth: number, etaWidth: number, compact = false, now = state.now) => (
      <box flexDirection="column">
        <text fg={textColor()}>{service.name}</text>
        {service.error ? <text fg={feedback("error")}>{`  error: ${service.error}`}</text> : null}
        {limitNote(service, now) ? <text fg={feedback("warning")}>{`  ${limitNote(service, now)}`}</text> : null}
        {service.windows.map((w) => {
          const fg = colorFor(w.usedPercent)
          const time = eta(w.resetsAt).padStart(etaWidth)
          return (
            <box flexDirection="row">
              {Parts([
                { text: `  ${w.label.padEnd(labelWidth)}  `, fg },
                ...barParts(w.usedPercent),
                { text: compact ? ` ${time}` : `  reset ${time}`, fg },
              ])}
            </box>
          )
        })}
        {(service.notes ?? []).map((note) => (
          <text fg={textColor()}>{`  ${note}`}</text>
        ))}
      </box>
    )

    // The sidebar: the current model's provider with all its windows, as /quota shows it but for that one provider.
    const sidebarContent = () => {
      const { provider } = modelRef()
      const service = state.services.find((s) => s.providers.includes(provider))
      if (!service) return null
      const labelWidth = Math.max(0, ...service.windows.map((w) => w.label.length))
      // Reading state.now also makes the block re-render each minute, keeping the times current.
      const etaWidth = Math.max(0, ...service.windows.map((w) => eta(w.resetsAt, state.now).length))
      return serviceBlock(service, labelWidth, etaWidth, true)
    }

    // The /quota panel: same colors and bar as the footer. Titles use the bar's text color to stand out.
    const showPanel = (services: QuotaService[]) => {
      const windows = services.flatMap((service) => service.windows)
      // One set of column widths for every service so the columns line up across blocks.
      const labelWidth = Math.max(0, ...windows.map((w) => w.label.length))
      const etaWidth = Math.max(0, ...windows.map((w) => eta(w.resetsAt).length))
      const base = textColor()
      // Elements can only be created while the dialog renders, so the blocks are built inside this callback.
      const blocks = () => services.map((service) => serviceBlock(service, labelWidth, etaWidth, false, Date.now()))
      context.ui.dialog.show(() => (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
          <text fg={textColor()}>Quota (used)</text>
          {services.length === 0 ? (
            <text fg={base}>No credentials found for known providers (Claude, OpenAI, OpenCode Go).</text>
          ) : null}
          {blocks()}
        </box>
      ))
    }

    const configure = async () => {
      while (true) {
        const alertHours = settings.resetAlertHours
        const choice = await context.ui.dialog.select({
          title: "Quota footer",
          options: [
            { title: `${showQuota() ? "[x]" : "[ ]"} Show quota bars`, value: "show" },
            {
              title: `OpenAI reset expiration alert: ${alertHours > 0 ? `${alertHours}h` : "disabled"}`,
              value: "alert",
            },
            { title: "Done", value: "done" },
          ],
        })
        if (choice === undefined || choice === "done") return
        if (choice === "alert") {
          const answer = await context.ui.dialog.prompt({
            title: "Hours before expiration to show alert (0 = disabled)",
            placeholder: String(alertHours),
          })
          if (answer === undefined) continue
          const hours = Number(answer)
          if (Number.isFinite(hours) && hours >= 0) await updateSettings((draft) => void (draft.resetAlertHours = hours))
          continue
        }
        if (choice === "show") await updateSettings((draft) => void (draft.show = !showQuota()))
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "quota.show",
          title: "Show quota",
          group: "Quota",
          palette: true,
          slash: { name: "quota" },
          run: async () => {
            try {
              // The one place that asks for every provider; the answer also refreshes the footer's data.
              const { services } = await context.client.rpc(Quota).usage({})
              merge(services, services.flatMap((s) => s.providers))
              showPanel(services)
            } catch (error) {
              await context.ui.dialog.alert({ title: "Quota", message: `error: ${describe(error)}` })
            }
          },
        },
        {
          id: "quota.footer",
          title: "Configure quota footer",
          group: "Quota",
          palette: true,
          slash: { name: "quota-footer" },
          run: async () => {
            await refresh()
            await configure()
          },
        },
      ],
    }))

    const unregisterSlot = context.ui.slot({
      append: FOOTER_SLOT,
      // An empty <text> still takes a row, so with nothing to show the box has no children at all.
      render: () => (
        <box flexDirection="row">
          {footerParts().map((part) => (
            <text fg={part.fg} bg={part.bg}>
              {part.text}
            </text>
          ))}
        </box>
      ),
    })
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        // This slot only renders while the sidebar is open, which is how the top line knows to step aside.
        if (onCleanup) {
          updateUi((draft) => void (draft.sidebar = true))
          onCleanup(() => updateUi((draft) => void (draft.sidebar = false)))
        }
        return <box flexDirection="column">{sidebarContent()}</box>
      },
    })
    const stopEvents = context.data.on("session.execution.succeeded", () => void refresh())
    // Keeps the remaining times current between refreshes; it makes no network calls.
    const tick = setInterval(() => updateState((draft) => void (draft.now = Date.now())), 60_000)
    void refresh()

    return () => {
      clearInterval(tick)
      stopEvents()
      unregisterSlot?.()
      unregisterSidebar?.()
    }
  },
})
