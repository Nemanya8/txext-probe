// Chain-side facts the probe needs to judge each host answer: what the runtime
// declares (extrinsic formats, transaction-extension pipelines), and what the
// bytes a host hands back actually are.

import { decAnyMetadata } from "@polkadot-api/substrate-bindings"

// Hosts serve only the new JSON-RPC spec (chainHead_*), so the legacy
// state_* methods are refused ("not supported by the host"): everything is
// read through papi's runtime-API and constant views instead.
type Client = { getUnsafeApi: () => any }

export interface RuntimeFacts {
  specName: string
  specVersion: number
  metadataVersion: string
  /** extrinsic format versions the runtime accepts (4, 5) */
  formatVersions: number[]
  /** transaction-extension version → extension identifiers, in pipeline order */
  pipelines: Record<number, string[]>
  /** VerifyMultiSignature's enum variants by SCALE index, when the runtime has it */
  verifyVariants?: Record<number, string>
  /** whether each pipeline's first extension encodes to zero bytes */
  firstIsEmpty: Record<number, boolean>
}

function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** SCALE compact prefix: [value, prefix length in bytes] */
function readCompact(bytes: Uint8Array, at = 0): [number, number] {
  const mode = bytes[at] & 3
  if (mode === 0) return [bytes[at] >> 2, 1]
  if (mode === 1) return [(bytes[at] | (bytes[at + 1] << 8)) >> 2, 2]
  if (mode === 2) return [(bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 2, 4]
  throw new Error("compact length too large for this probe")
}

export async function readRuntimeFacts(client: Client): Promise<RuntimeFacts> {
  const api = client.getUnsafeApi()
  const version: { spec_name: string; spec_version: number } = await api.constants.System.Version()
  // Option<OpaqueMetadata>: papi hands back the bytes, or undefined
  const opaque: Uint8Array | string | undefined = await api.apis.Metadata.metadata_at_version(16)
  if (!opaque) throw new Error("runtime serves no v16 metadata")
  const decoded = decAnyMetadata(typeof opaque === "string" ? fromHex(opaque) : opaque) as any
  const md = decoded.metadata.value
  const ex = md.extrinsic
  const exts: Array<{ identifier: string; type: number }> = ex.transactionExtensions ?? ex.signedExtensions
  const byVersion: Array<[number, number[]]> = ex.transactionExtensionsByVersion ?? [[0, exts.map((_: unknown, i: number) => i)]]

  const lookup = new Map<number, any>(md.lookup.map((entry: any) => [entry.id, entry]))
  const isEmpty = (id: number): boolean => {
    const def = lookup.get(id)?.def
    if (!def) return false
    if (def.tag === "tuple") return def.value.every((inner: number) => isEmpty(inner))
    if (def.tag === "composite") return def.value.every((field: any) => isEmpty(field.type))
    return false
  }

  const pipelines: Record<number, string[]> = {}
  const firstIsEmpty: Record<number, boolean> = {}
  for (const [v, indexes] of byVersion) {
    pipelines[v] = indexes.map((i) => exts[i].identifier)
    firstIsEmpty[v] = indexes.length > 0 && isEmpty(exts[indexes[0]].type)
  }

  let verifyVariants: Record<number, string> | undefined
  const verify = exts.find((e) => e.identifier === "VerifyMultiSignature")
  const verifyDef = verify ? lookup.get(verify.type)?.def : undefined
  if (verifyDef?.tag === "variant") {
    verifyVariants = Object.fromEntries(verifyDef.value.map((v: any) => [v.index, v.name]))
  }

  return {
    specName: version.spec_name,
    specVersion: version.spec_version,
    metadataVersion: decoded.metadata.tag,
    formatVersions: ex.version,
    pipelines,
    verifyVariants,
    firstIsEmpty,
  }
}

export interface Envelope {
  /** e.g. "v4 signed", "v5 general (ext v0)" */
  label: string
  formatVersion: number
  kind: "signed" | "bare" | "general" | "unknown"
  extensionVersion?: number
  /** VerifyMultiSignature variant, decoded when the pipeline allows it */
  verify?: string
  bytes: number
}

/** What a host-built transaction is, from its first bytes. */
export function describeEnvelope(tx: Uint8Array, facts: RuntimeFacts | null): Envelope {
  const [, prefix] = readCompact(tx)
  const head = tx[prefix]
  const formatVersion = head & 0x3f
  const preamble = head >> 6
  const kind = preamble === 0b10 ? "signed" : preamble === 0b00 ? "bare" : preamble === 0b01 ? "general" : "unknown"
  const envelope: Envelope = { label: `v${formatVersion} ${kind}`, formatVersion, kind, bytes: tx.length }
  if (kind !== "general") return envelope

  const extensionVersion = tx[prefix + 1]
  envelope.extensionVersion = extensionVersion
  envelope.label += ` (ext v${extensionVersion})`
  // On People the pipeline opens with the zero-byte UnitTransactionExtension,
  // then VerifyMultiSignature — so its variant is the next byte. Only decoded
  // when the runtime facts confirm that layout.
  const pipeline = facts?.pipelines[extensionVersion]
  if (facts?.verifyVariants && pipeline && pipeline[1] === "VerifyMultiSignature" && facts.firstIsEmpty[extensionVersion]) {
    envelope.verify = facts.verifyVariants[tx[prefix + 2]] ?? `variant #${tx[prefix + 2]}`
    envelope.label += `, VerifyMultiSignature=${envelope.verify}`
  }
  return envelope
}
