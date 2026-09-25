// One log, three sinks: the on-screen list, the console (the Android host
// forwards console lines to logcat as "ProductWebChromeClientKt: Browser: …",
// so `adb logcat | grep txprobe` reads a run live), and window.__txprobe for a
// devtools/CDP export. Downloads do not work inside the host, so there is no
// file sink.

export type Level = "info" | "warn" | "error"

export interface Entry {
  t: string
  level: Level
  tag: string
  msg: string
  data?: unknown
}

const entries: Entry[] = []
const list = () => document.getElementById("log") as HTMLOListElement

/** JSON that survives bigint, Uint8Array and Error causes */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return `${v}n`
    if (v instanceof Uint8Array) return toHex(v)
    if (v instanceof Error) return { name: v.name, message: v.message, cause: v.cause }
    return v
  })
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

export function log(tag: string, msg: string, data?: unknown, level: Level = "info"): void {
  const entry: Entry = { t: new Date().toISOString(), level, tag, msg, data }
  entries.push(entry)
  const line = `[txprobe] ${tag} ${msg}${data === undefined ? "" : " " + stringify(data)}`
  ;(level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line)

  const li = document.createElement("li")
  li.className = level === "info" ? "" : level === "warn" ? "warn" : "err"
  const time = entry.t.slice(11, 23)
  li.innerHTML = `<span class="t">${time}</span> <span class="tag">[${tag}]</span> `
  li.append(msg + (data === undefined ? "" : "\n" + JSON.stringify(JSON.parse(stringify(data)), null, 1)))
  list().append(li)
}

export function exportLog(meta: Record<string, unknown>): string {
  return JSON.stringify({ meta: { ...meta, exportedAt: new Date().toISOString() }, entries: JSON.parse(stringify(entries)) }, null, 2)
}

export function clearLog(): void {
  entries.length = 0
  list().replaceChildren()
}

declare global {
  interface Window {
    __txprobe?: { entries: Entry[]; export: () => string }
  }
}

export function exposeLog(meta: () => Record<string, unknown>): void {
  window.__txprobe = { entries, export: () => exportLog(meta()) }
}
