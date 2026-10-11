export type TurnCost = {
  /** The turn's length as shown: `48.5s`, `1m5s`, `1h2m5s`. */
  duration: string
  /** CPU load over the turn, in percent; null for a short turn or no samples. */
  cpu: {
    avg: number
    peak: number
    /** Samples inside the turn, and how many of them were at the hot threshold. */
    sampleCount: number
    hotSamples: number
    /** One bar per bucket of samples: its mean, its maximum, and its first sample's time. */
    points: number[]
    peaks?: number[]
    times: number[]
  } | null
  /** Free RAM over the turn (shown in GB) and its paging peak; same turns as `cpu`. */
  mem: { avg: string; min: string; pagesPeak: number } | null
  /** Share and time of the session's CPU samples at 80% or more; null before any. */
  hot: { percent: number; minutes: number } | null
  /** The context window's fill after the turn; null when the engine gave none. */
  context: { tokens: string; percent: number | null } | null
  /** The model that answered; null when the turn recorded no usage. */
  model: string | null
  /** The effort the turn's last request asked for (`high`); null when the model takes none. */
  effort: string | null
  /** Absent when the turn recorded no usage (interrupted, API error). */
  tokens: { input: string; output: string; read: string; write: string } | null
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'turn-monitor': { last: TurnCost | null; isOpen: boolean }
  }
}
