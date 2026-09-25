// txExtVersion probe.
//
// Asks the host to build the SAME harmless transaction (System.remark, never
// submitted) under each txExtVersion convention, then records what the host
// did: the exact create_transaction request, the host's answer or error, the
// envelope it built (v4 / v5 general, extension version, VerifyMultiSignature
// variant), and whether the chain would accept those bytes (a
// TaggedTransactionQueue.validate_transaction dry run — nothing is broadcast).
//
// Background: the TrUAPI reference host reads txExtVersion 0 as "V4" and 5 as
// "V5 format", taking the extension version from metadata. The Android and iOS
// community hosts read any non-zero value as the extension version itself.

import * as sdk from "@parity/product-sdk-host"
import { Binary, Enum, createClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import type { PolkadotSigner } from "polkadot-api/signer"
import { describeEnvelope, readRuntimeFacts, type Envelope, type RuntimeFacts } from "./chain"
import { clearLog, exportLog, exposeLog, log, stringify, toHex } from "./log"

const PRODUCT_DOTNS: string = import.meta.env.VITE_PRODUCT_DOTNS ?? "txextprobe.paseo"
const PASEO_NEXT_V2_PEOPLE_GENESIS = "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48"
const PEOPLE_WS: string = import.meta.env.VITE_PEOPLE_WS ?? "wss://paseo-people-next-system-rpc.polkadot.io"
const CASE_TIMEOUT_MS = 150_000

// papi cannot default this enum; "Disabled" is the value every individuality
// client sends (see jollity-next packages/game-chain/src/chain/tx.ts)
const CUSTOM_EXTENSIONS = { VerifyMultiSignature: { value: { type: "Disabled", value: undefined } } }

interface Case {
  id: string
  title: string
  desc: string
  /** null → the SDK's stock product signer decides the request */
  txExtVersion: number | null
  /** drop the product-supplied VerifyMultiSignature so the host must sign */
  dropVerify?: boolean
}

const CASES: Case[] = [
  { id: "stock", title: "Stock SDK signer", desc: "getProductAccountSigner — whatever the SDK asks for", txExtVersion: null },
  { id: "v0", title: "txExtVersion 0", desc: "host default format, all extensions forwarded", txExtVersion: 0 },
  { id: "v0-noverify", title: "txExtVersion 0, no VerifyMultiSignature", desc: "host default, host fills the signature", txExtVersion: 0, dropVerify: true },
  { id: "v5", title: "txExtVersion 5", desc: "what dim2 sends today (all extensions)", txExtVersion: 5 },
  { id: "v5-noverify", title: "txExtVersion 5, no VerifyMultiSignature", desc: "V5 selector, host fills the signature", txExtVersion: 5, dropVerify: true },
  { id: "v1", title: "txExtVersion 1 (control)", desc: "reference host rejects; native hosts read ext v1", txExtVersion: 1 },
]

interface Outcome {
  host: string
  hostClass: "ok" | "err" | "warn"
  envelope?: Envelope
  chain?: string
  chainClass?: "ok" | "err" | "warn"
}

// --- state -----------------------------------------------------------------

const meta: Record<string, unknown> = {
  app: "txext-probe",
  product: PRODUCT_DOTNS,
  ua: navigator.userAgent,
  sdk: __SDK_VERSION__,
  papi: __PAPI_VERSION__,
}
let client: ReturnType<typeof createClient> | null = null
let facts: RuntimeFacts | null = null
let accounts: Awaited<ReturnType<typeof sdk.getAccountsProvider>> = null
let account: any = null
let truApi: any = null
let running = false
const outcomes = new Map<string, Outcome>()

// --- setup -----------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

function hostError(error: unknown): string {
  try {
    const format = (sdk as any).formatHostError
    if (typeof format === "function") return String(format(error))
  } catch {
    /* fall through */
  }
  return stringify(error)
}

/** Log every call the SDK makes on truApi.signing, whoever makes it. */
function instrumentSigning(api: any): void {
  const signing = api?.signing
  if (!signing || signing.__txprobe) return
  for (const name of Object.keys(signing).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(signing)))) {
    const original = signing[name]
    if (typeof original !== "function" || name === "constructor") continue
    signing[name] = (request: any, ...rest: unknown[]) => {
      log("host-call", `signing.${name} →`, summarizeRequest(request))
      const result = original.call(signing, request, ...rest)
      if (result && typeof result.map === "function" && typeof result.mapErr === "function") {
        return result
          .map((value: any) => {
            log("host-call", `signing.${name} ← ok`, value)
            return value
          })
          .mapErr((error: unknown) => {
            log("host-call", `signing.${name} ← error`, { formatted: hostError(error), raw: error }, "error")
            return error
          })
      }
      return result
    }
  }
  signing.__txprobe = true
}

function summarizeRequest(request: any): unknown {
  if (!request || typeof request !== "object") return request
  const { extensions, callData, ...rest } = request
  return {
    ...rest,
    callData,
    extensions: Array.isArray(extensions)
      ? extensions.map((e: any) => ({ id: e.id, extra: e.extra, additionalSigned: e.additionalSigned }))
      : extensions,
  }
}

async function setup(): Promise<void> {
  const inside = sdk.isInsideContainerSync()
  meta.insideHost = inside
  log("env", inside ? "inside a host container" : "NOT inside a host — host cases will fail", {
    product: PRODUCT_DOTNS,
    ua: navigator.userAgent,
    sdk: __SDK_VERSION__,
  }, inside ? "info" : "warn")

  let genesis = PASEO_NEXT_V2_PEOPLE_GENESIS
  let provider: any = null
  if (inside) {
    try {
      const discovery = await withTimeout(sdk.getHostChainInfo(["People"] as any), 5000, "chain discovery")
      const discovered = (discovery as any)?.chains?.People
      log("env", "People chain discovery", { discovered: discovered ?? null })
      if (discovered) genesis = discovered
    } catch (error) {
      log("env", "chain discovery failed, using the paseo-next-v2 genesis", { error: hostError(error) }, "warn")
    }
    try {
      provider = await sdk.getHostProvider(genesis as `0x${string}`)
      log("env", provider ? "reading People through the host provider" : "host serves no provider for People", { genesis })
    } catch (error) {
      log("env", "host provider unavailable", { error: hostError(error) }, "warn")
    }
  }
  if (!provider) {
    log("env", "reading People over a direct WebSocket", { url: PEOPLE_WS })
    provider = getWsProvider(PEOPLE_WS)
  }
  meta.peopleGenesis = genesis
  client = createClient(provider)

  try {
    facts = await withTimeout(readRuntimeFacts(client), 30_000, "runtime metadata")
    meta.runtime = facts
    log("chain", `${facts.specName} ${facts.specVersion}, metadata ${facts.metadataVersion}`, {
      formatVersions: facts.formatVersions,
      extensionVersions: Object.keys(facts.pipelines).map(Number),
      pipelines: facts.pipelines,
      verifyVariants: facts.verifyVariants,
    })
  } catch (error) {
    log("chain", "could not read runtime metadata", { error: String(error) }, "error")
  }

  if (!inside) return
  try {
    accounts = await sdk.getAccountsProvider()
    truApi = await sdk.getTruApi()
    instrumentSigning(truApi)
    if (!accounts || !truApi) throw new Error(`accounts=${!!accounts} truApi=${!!truApi}`)
    account = await accounts.getProductAccount(PRODUCT_DOTNS, 0).match(
      (value) => value,
      (error) => {
        throw new Error(`getProductAccount(${PRODUCT_DOTNS}) failed: ${hostError(error)}`)
      },
    )
    meta.account = { dotNsIdentifier: account.dotNsIdentifier, derivationIndex: account.derivationIndex, publicKey: toHex(account.publicKey) }
    log("account", "product account resolved", meta.account)
  } catch (error) {
    log("account", "no product account — signing cases cannot run", { error: String(error) }, "error")
  }
}

// --- the probe ---------------------------------------------------------------

/** A signer that sends create_transaction with an explicit txExtVersion. */
function probeSigner(c: Case, inner: PolkadotSigner): PolkadotSigner {
  return {
    publicKey: inner.publicKey,
    signBytes: (data) => inner.signBytes(data),
    async signTx(callData, signedExtensions) {
      const genesis = signedExtensions["CheckGenesis"]
      if (!genesis) throw new Error("the transaction carries no CheckGenesis")
      let extensions = Object.values(signedExtensions).map((e) => ({
        id: e.identifier,
        extra: toHex(e.value),
        additionalSigned: toHex(e.additionalSigned),
      }))
      if (c.dropVerify) extensions = extensions.filter((e) => e.id !== "VerifyMultiSignature")
      const response = await truApi.signing.createTransaction({
        signer: {
          dotNsIdentifier: account.dotNsIdentifier,
          derivationIndex: { tag: "Index", value: account.derivationIndex },
        },
        genesisHash: toHex(genesis.additionalSigned),
        callData: toHex(callData),
        extensions,
        txExtVersion: c.txExtVersion,
      })
      return response.match(
        (value: { transaction: string }) => fromHex(value.transaction),
        (error: unknown) => {
          throw new HostRefusal(hostError(error))
        },
      )
    },
  }
}

class HostRefusal extends Error {}

function stripLengthPrefix(tx: Uint8Array): Uint8Array {
  const mode = tx[0] & 3
  return tx.subarray(mode === 0 ? 1 : mode === 1 ? 2 : 4)
}

function fromHex(hex: string): Uint8Array {
  return Binary.fromHex(hex as `0x${string}`)
}

async function dryRun(tx: Uint8Array): Promise<{ text: string; cls: "ok" | "err" | "warn" }> {
  if (!client) return { text: "no chain client", cls: "warn" }
  try {
    const api = client.getUnsafeApi() as any
    const best = await client.getFinalizedBlock()
    // papi length-prefixes the extrinsic argument itself; the signed bytes
    // already carry one, and a doubled prefix traps the runtime
    const result = await api.apis.TaggedTransactionQueue.validate_transaction(Enum("External"), stripLengthPrefix(tx), best.hash)
    const json = JSON.parse(stringify(result))
    log("chain", "validate_transaction", { block: best.hash, result: json })
    if (result?.success === true) return { text: "valid", cls: "ok" }
    // an unfunded probe account is expected to fail on payment: that still
    // proves the chain DECODED the envelope, unlike BadProof / decode errors
    const reason = stringify(result?.value ?? result)
    const paymentOnly = /Payment/.test(reason)
    return { text: `invalid: ${reason}`, cls: paymentOnly ? "warn" : "err" }
  } catch (error) {
    log("chain", "validate_transaction threw (usually: the bytes do not decode)", { error: String(error) }, "error")
    return { text: `threw: ${String(error)}`, cls: "err" }
  }
}

async function runCase(c: Case): Promise<void> {
  if (!client || !accounts || !account || !truApi) {
    log(c.id, "skipped — setup incomplete (see above)", undefined, "warn")
    record(c, { host: "skipped", hostClass: "warn" })
    return
  }
  log(c.id, `▶ ${c.title}`, { txExtVersion: c.txExtVersion ?? "SDK decides", dropVerify: !!c.dropVerify })
  setStatus(c.id, "waiting for host…")
  const stock = accounts.getProductAccountSigner(account)
  const signer = c.txExtVersion === null ? stock : probeSigner(c, stock)
  const api = client.getUnsafeApi() as any
  const tx = api.tx.System.remark({ remark: Binary.fromText(`txext-probe ${c.id} ${Date.now()}`) })

  const sign = () => withTimeout<Uint8Array>(tx.sign(signer, { customSignedExtensions: CUSTOM_EXTENSIONS }), CASE_TIMEOUT_MS, "host signing")
  let signed: Uint8Array
  try {
    try {
      signed = await sign()
    } catch (error) {
      // papi can race the host provider's block pins between cases; that is
      // the probe's problem, not the host's, so it gets one retry
      if (!(error instanceof Error && error.name === "BlockNotPinnedError")) throw error
      log(c.id, "block unpinned mid-sign — retrying once", { error: error.message }, "warn")
      signed = await sign()
    }
  } catch (error) {
    const text = error instanceof HostRefusal ? `refused: ${error.message}` : `failed: ${error instanceof Error ? error.message : String(error)}`
    log(c.id, `host ${text}`, { error }, "error")
    record(c, { host: text, hostClass: "err" })
    return
  }

  const envelope = describeEnvelope(signed, facts)
  log(c.id, `host built ${envelope.label}`, { envelope, tx: toHex(signed) })
  const verdict = await dryRun(signed)
  record(c, { host: "built", hostClass: "ok", envelope, chain: verdict.text, chainClass: verdict.cls })
}

// --- UI ----------------------------------------------------------------------

function record(c: Case, outcome: Outcome): void {
  outcomes.set(c.id, outcome)
  setStatus(c.id, outcome.envelope ? outcome.envelope.label : outcome.host)
  renderSummary()
}

function setStatus(id: string, text: string): void {
  const el = document.querySelector<HTMLElement>(`[data-status="${id}"]`)
  if (el) el.textContent = text
}

function renderSummary(): void {
  const body = document.querySelector("#summary tbody") as HTMLTableSectionElement
  body.replaceChildren(
    ...CASES.filter((c) => outcomes.has(c.id)).map((c) => {
      const o = outcomes.get(c.id)!
      const tr = document.createElement("tr")
      const cell = (text: string, cls = "") => {
        const td = document.createElement("td")
        td.textContent = text
        if (cls) td.className = cls
        return td
      }
      tr.append(
        cell(c.id),
        cell(o.host, o.hostClass),
        cell(o.envelope?.label ?? "—"),
        cell(o.chain ?? "—", o.chainClass ?? ""),
      )
      return tr
    }),
  )
  meta.summary = Object.fromEntries(outcomes)
}

async function guarded(work: () => Promise<void>): Promise<void> {
  if (running) return
  running = true
  document.querySelectorAll("button[data-run]").forEach((b) => ((b as HTMLButtonElement).disabled = true))
  try {
    await work()
  } finally {
    running = false
    document.querySelectorAll("button[data-run]").forEach((b) => ((b as HTMLButtonElement).disabled = false))
  }
}

function renderCases(): void {
  const wrap = document.getElementById("cases")!
  const all = document.createElement("div")
  all.className = "case"
  all.innerHTML = `<div class="text"><div class="title">Run all cases</div><div class="desc">one after another; approve or reject each host sheet</div></div>`
  const allButton = document.createElement("button")
  allButton.textContent = "Run all"
  allButton.dataset.run = "all"
  allButton.onclick = () =>
    guarded(async () => {
      for (const c of CASES) await runCase(c)
      log("summary", "all cases done", meta.summary)
    })
  all.append(allButton)
  wrap.append(all)

  for (const c of CASES) {
    const row = document.createElement("div")
    row.className = "case"
    row.innerHTML = `<div class="text"><div class="title"></div><div class="desc"></div><div class="status" data-status="${c.id}">not run</div></div>`
    row.querySelector(".title")!.textContent = c.title
    row.querySelector(".desc")!.textContent = c.desc
    const button = document.createElement("button")
    button.className = "secondary"
    button.textContent = "Run"
    button.dataset.run = c.id
    button.onclick = () => guarded(() => runCase(c))
    row.append(button)
    wrap.append(row)
  }
}

async function copyLog(): Promise<void> {
  const text = exportLog(meta)
  try {
    await navigator.clipboard.writeText(text)
    log("ui", `copied ${text.length} chars`)
  } catch {
    // clipboard is often denied inside a host webview: fall back to selection
    const area = document.createElement("textarea")
    area.value = text
    document.body.append(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    log("ui", ok ? `copied ${text.length} chars (fallback)` : "copy failed — use adb logcat | grep txprobe", undefined, ok ? "info" : "warn")
  }
}

declare const __SDK_VERSION__: string
declare const __PAPI_VERSION__: string

async function main(): Promise<void> {
  exposeLog(() => meta)
  renderCases()
  document.getElementById("copy")!.onclick = () => void copyLog()
  document.getElementById("clear")!.onclick = () => clearLog()
  await setup()
  const env = document.getElementById("env")!
  env.textContent = [
    meta.insideHost ? "in host" : "no host",
    PRODUCT_DOTNS,
    facts ? `${facts.specName} ${facts.specVersion} · formats ${facts.formatVersions.join("/")} · ext versions ${Object.keys(facts.pipelines).join("/")}` : "runtime unknown",
    account ? `account ${toHex(account.publicKey).slice(0, 10)}…` : "no account",
  ].join(" · ")
}

void main()
