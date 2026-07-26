// Shared shapes, plus the cross-file globals of the MV2 background scripts.
// The scripts share one global scope at runtime, but the CommonJS guard the
// pure modules carry (so node --test can require them) makes tsc treat those
// files as modules and hide their exports -- the globals they attach are
// declared here instead.

type Health = 'up' | 'down' | 'misrouted' | 'unknown'

interface ContainerConfig {
  ip: string
  port: number
  /** WireGuard hostname shown to the user, e.g. se-got-wg-001 */
  host: string
  /** First label of socks_name; what am.i.mullvad.net reports as the exit */
  socksHost: string
  city: string
  country: string
  cc: string
  health?: Health
  healthDetail?: string
  healthAt?: number
  exitIp?: string
}

interface GateRequest {
  url: string
  cookieStoreId?: string
  type?: string
}

interface KillswitchState {
  ready: boolean
  hydrateError?: string
  dohActive?: boolean
  strict: boolean
  containers: Record<string, ContainerConfig>
  probeTokens: Set<string>
}

interface Verdict {
  verdict: 'allow' | 'block'
  reason: string
}

interface Relay {
  host: string
  socksName: string
  socksHost: string
  socksPort: number
  cc: string
  country: string
  city: string
  active: boolean
  owned: boolean
  speed: number
  messages: string[]
}

interface OfflineAssignment {
  cookieStoreId: string
  host: string
  alternative: Relay | undefined
}

interface BlockEntry {
  t: number
  url: string
  type: string
  container: string
  reason: string
}

// decide.js
declare function decide(state: KillswitchState, req: GateRequest): Verdict
declare function probeToken(url: string): string | null
declare function isProbeUrl(url: string): boolean
declare function usableProxy(c: ContainerConfig | undefined): boolean
declare const R: {
  PROBE: string
  NOT_READY: string
  SPECULATIVE: string
  UNATTRIBUTED: string
  UNMANAGED: string
  NO_PROXY: string
  PROXY_DOWN: string
  NOT_VERIFIED: string
  MISROUTED: string
  ERROR: string
  OK: string
}
declare const PROBE_MARKER: string
declare const PROBE_URL: string

// relays.js
declare var relaylib: {
  adaptPublic(json: unknown): Relay[]
  adaptTunnel(json: unknown): Relay[]
  searchRelays(relays: Relay[], q: string, f?: { ownedOnly?: boolean }): Relay[]
  groupByLocation(relays: Relay[]): { cc: string, country: string, cities: { city: string, relays: Relay[] }[] }[]
  findRelay(relays: Relay[], host: string): Relay | undefined
  alternativeFor(relays: Relay[], gone: { host: string, city: string, cc: string }): Relay | undefined
  offlineAssigned(containers: Record<string, ContainerConfig>, relays: Relay[]): OfflineAssignment[]
  mergeAssignments(prev: Record<string, ContainerConfig>, next: Record<string, ContainerConfig>): { containers: Record<string, ContainerConfig>, stale: string[] }
  isTunnelAddress(ip: string): boolean
  configKey(c: ContainerConfig | undefined): string
  renamedTo(c: ContainerConfig, observedSocksHost: string, relays: Relay[]): Relay | undefined
}

// ui/fmt.js
declare var fmt: {
  timeAgo(ts: number | undefined, now: number): string
  healthLabel(health: string | undefined): string
  healthClass(health: string | undefined): string
  explainDetail(detail: string | undefined): string
  rawDetail(detail: string | undefined): string
  reasonLabel(reason: string): string
  flagSrc(cc: string): string
  relayTags(r: Relay): string[]
}

// ui/picker.js
interface PickerOptions {
  relays: Relay[]
  recents: string[]
  favorites: string[]
  currentHost: string
  onPick(host: string): void
  onFavorite(host: string, on: boolean): void
}
declare function createPicker(opts: PickerOptions): { el: HTMLElement, focus(): void }

// What getState answers over runtime messaging
interface StateSnapshot {
  ready: boolean
  hydrateError: string
  dohActive: boolean
  strict: boolean
  containers: Record<string, ContainerConfig>
  blockLog: BlockEntry[]
  relays: { ts: number, source: string, count: number, offline: OfflineAssignment[] }
  renamed: Record<string, string>
  privateAllowed: boolean
  prefsAck: boolean
  recents: string[]
  favorites: string[]
  version: string
}

// Firefox background-window global; gone from lib.dom
declare function dump(s: string): void

// The CommonJS guard the dual-loaded modules carry
declare var module: { exports: unknown } | undefined
