import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TurnCost } from '../types'

const last = atom({ plugin: 'turn-monitor', key: 'last' } as const, null)
// Whether the CPU card under the band is expanded (a click on the cpu group).
const isOpen = atom({ plugin: 'turn-monitor', key: 'isOpen' } as const, false)

// 999 -> 999, 1783 -> 1.8k, 240962 -> 241k, 1234567 -> 1.2M
const short = (x: number) => x.toFixed(1).replace(/\.0$/, '')

const count = (n: number) => {
  if (n < 1_000) return String(n)
  if (n < 999_950) return `${short(n / 1_000)}k`
  return `${short(n / 1_000_000)}M`
}

// 48500 -> 48.5s, 65000 -> 1m5s, 3725000 -> 1h2m5s
const duration = (ms: number) => {
  const total = ms / 1000

  if (total < 59.95) return `${total.toFixed(1)}s`

  const s = Math.round(total)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60

  return h > 0 ? `${h}h${m}m${r}s` : `${m}m${r}s`
}

// The share of a turn's CPU samples at or above the hot threshold, in percent.
const hotShare = (cpu: { hotSamples: number; sampleCount: number }) =>
  Math.round((cpu.hotSamples / cpu.sampleCount) * 100)

// Time spent at the hot threshold, from the samples counted: 0s, 15s, 1m5s.
const hotTime = (samples: number) => {
  const s = samples * SAMPLE_SECONDS

  return s < 60 ? `${s}s` : duration(s * 1000)
}

// claude-sonnet-5-5 -> Sonnet 5.5, claude-opus-4-1-20250805 -> Opus 4.1,
// claude-3-5-sonnet-20241022 -> Sonnet 3.5; anything unrecognised is kept as it is.
const modelName = (id: string) => {
  const parts = id
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .split('-')
    .filter(p => p !== '' && !/^\d{8}$/.test(p))
  const family = parts.filter(p => !/^\d+$/.test(p))
  const version = parts.filter(p => /^\d+$/.test(p))

  if (family.length === 0) return id

  const name = family.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')

  return version.length === 0 ? name : `${name} ${version.join('.')}`
}

// The first group: the model, then the effort it was asked for when it takes one
// (a turn kept in state from before the effort was recorded has none either).
// The effort starts with a capital: high -> High.
const modelLabel = (turn: TurnCost) =>
  turn.model === null || turn.effort === null || turn.effort === undefined
    ? turn.model
    : `${turn.model} ${turn.effort.charAt(0).toUpperCase()}${turn.effort.slice(1)}`

// One colour per group, in drawing order: model, time, context, input, output.
const MODEL = '#facc15'
const TIME = '#3b82f6'
const CONTEXT = '#10b981'
const INPUT = '#a855f7'
const OUTPUT = '#86efac'
const CPU = '#fb923c'
const MEM = '#22d3ee'

// CPU load is sampled by one long-running typeperf, and shown only for turns
// that took longer than this.
const MIN_TURN_MS = 20_000
const SAMPLE_SECONDS = 2
const KEEP_SAMPLES = 5_000

// How much of the whole session the CPU spends at or above this load.
const CPU_HOT_PERCENT = 80
const HOT = '#ea580c'
const CONTEXT_HIGH = '#ef4444'

// The space between two groups.
const GAP = '    '

// In front of the dimmed band while a turn runs.
const STALE_LABEL = 'last turn'

// The context turns red and bold, with !!!, from this fill upwards.
const HIGH_PERCENT = 80
const isHigh = (percent: number | null) => percent !== null && percent >= HIGH_PERCENT

// The CPU graph of one turn, captured when the turn ends and kept as it was: one
// bar per bucket of samples (its mean, so the red share of the bars tracks the
// share of hot samples), red from the hot threshold, with a thin tick at the
// bucket's peak (red from the hot threshold, orange below) so a spike stays visible. It sits in a card that hovering the cpu group reveals.
const GRAPH_W = 240
const GRAPH_H = 36
const GRAPH_MAX_BARS = 40

const downsample = (list: { t: number; v: number }[]) => {
  const size = Math.max(1, Math.ceil(list.length / GRAPH_MAX_BARS))
  const points: number[] = []
  const peaks: number[] = []
  const times: number[] = []

  for (let i = 0; i < list.length; i += size) {
    const bucket = list.slice(i, i + size)
    points.push(bucket.reduce((sum, s) => sum + s.v, 0) / bucket.length)
    peaks.push(Math.max(...bucket.map(s => s.v)))
    times.push(bucket[0]!.t)
  }

  return { points, peaks, times }
}

const clock = (ms: number) => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const sparkline = (points: number[], peaks: number[], times: number[]) => {
  const step = GRAPH_W / points.length
  const hotY = GRAPH_H - (CPU_HOT_PERCENT / 100) * GRAPH_H

  const bars = points.map((v, i) => {
    const h = Math.max(1, Math.round((v / 100) * GRAPH_H))
    const fill = v >= CPU_HOT_PERCENT ? CONTEXT_HIGH : CPU
    const peak = peaks[i] ?? v
    const title = `${clock(times[i] ?? 0)}  avg ${Math.round(v)}%, peak ${Math.round(peak)}%`
    const x = (i * step).toFixed(2)
    const w = Math.max(1, step - 1).toFixed(2)
    const peakH = Math.max(1, Math.round((peak / 100) * GRAPH_H))

    // The tick sits at the peak, only when it clears the bar's top by a pixel.
    const tick =
      peakH > h + 1
        ? `<rect x="${x}" y="${GRAPH_H - peakH}" width="${w}" height="1.5" ` +
          `fill="${peak >= CPU_HOT_PERCENT ? CONTEXT_HIGH : CPU}"/>`
        : ''

    return (
      `<rect x="${x}" y="${GRAPH_H - h}" width="${w}" height="${h}" fill="${fill}">` +
      `<title>${title}</title></rect>${tick}`
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GRAPH_W}" height="${GRAPH_H}" ` +
    `viewBox="0 0 ${GRAPH_W} ${GRAPH_H}">` +
    `<line x1="0" x2="${GRAPH_W}" y1="${hotY}" y2="${hotY}" stroke="#888" ` +
    `stroke-width="0.5" stroke-dasharray="2 2"/>${bars.join('')}</svg>`
  )
}

// The band's groups as one line of plain text, for the transcript.
const plainLine = (turn: TurnCost) => {
  if (turn.tokens === null) {
    return `${turn.duration}${GAP}no tokens recorded (${turn.reason})`
  }

  const t = turn.tokens
  const parts: string[] = []

  const model = modelLabel(turn)
  if (model !== null) parts.push(model)
  parts.push(turn.duration)

  if (turn.context !== null) {
    const percent = turn.context.percent === null ? '' : ` ${turn.context.percent}%`
    const warn = isHigh(turn.context.percent) ? ' !!!' : ''
    parts.push(`ctx:${turn.context.tokens}${percent}${warn}`)
  }

  parts.push(`cw:${t.write} in:${t.input} cr:${t.read}`)
  parts.push(`out:${t.output}`)

  if (turn.cpu !== null) {
    parts.push(`cpu:${turn.cpu.avg}% (${turn.cpu.peak}%, ${hotShare(turn.cpu)}%)`)
  }
  if (turn.mem !== null) parts.push(`free:${turn.mem.avg} (${turn.mem.min})`)

  return parts.join(GAP)
}

// One reading of the machine: CPU load (percent), processor queue length, free
// RAM (MB) and pages per second (the paging that signals memory pressure).
type Sample = { t: number; v: number; q: number; m: number; p: number }

// 9312 -> 9.1G
const gb = (mb: number) => `${(mb / 1024).toFixed(1)}G`

const mean = (xs: number[]) =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
const peakOf = (xs: number[]) => (xs.length === 0 ? null : Math.max(...xs))
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)

// Merges overlapping [start, end] spans, so parallel tool calls count once.
const merge = (spans: [number, number][]) => {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []

  for (const s of sorted) {
    const prev = out[out.length - 1]

    if (prev !== undefined && s[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], s[1])
    } else {
      out.push([s[0], s[1]])
    }
  }

  return out
}

export const register: Register = on => {
  let samples: Sample[] = []
  // Whole-session counters; the samples above are pruned, these are not.
  let total = 0
  let hot = 0

  // For the log: the session's title as the engine last reported it, and the
  // spans of this turn's tool calls.
  let title: string | null = null
  let toolSpans: [number, number][] = []
  let isLogFailureShown = false

  // The effort of this turn's last main-loop request; null when the model takes
  // none, or no request was made.
  let effort: string | null = null

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      effort = e.effort === undefined ? null : String(e.effort)
    }

    return yield* next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    title = e.session_title ?? title

    return next(e)
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    title = e.session_title ?? title

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()

    try {
      return await next(e)
    } finally {
      toolSpans.push([started, await $.clock.now()])
    }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // One child for the session's life; it ends with the module.
    void (async () => {
      try {
        const load = '\\Processor(_Total)\\% Processor Time'
        const queue = '\\System\\Processor Queue Length'
        const free = '\\Memory\\Available MBytes'
        const paging = '\\Memory\\Pages/sec'
        const child = $.process.spawn({
          argv: ['typeperf', load, queue, free, paging, '-si', String(SAMPLE_SECONDS)],
        })
        let rest = ''

        for await (const { stream, text } of child) {
          if (stream !== 'stdout') continue

          const lines = (rest + text).split(/\r?\n/)
          rest = lines.pop() ?? ''
          const t = await $.clock.now()

          for (const line of lines) {
            const m =
              /^"[^"]*","([0-9.]+)","([0-9.]+)","([0-9.]+)","([0-9.]+)"\s*$/.exec(line)
            if (m === null) continue

            const v = Number(m[1])
            samples.push({ t, v, q: Number(m[2]), m: Number(m[3]), p: Number(m[4]) })
            total += 1
            if (v >= CPU_HOT_PERCENT) hot += 1
          }
          if (samples.length > KEEP_SAMPLES) {
            samples = samples.slice(-KEEP_SAMPLES)
          }
        }
      } catch {
        // No typeperf (not Windows) or it failed to start: the band shows no CPU.
      }
    })()

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // A subagent's turns would overwrite the main loop's figures.
    if (e.agentId !== undefined) {
      return result
    }

    const u = e.usage
    const turnEffort = effort
    effort = null
    const { context } = await $.session.usage()

    // CPU over the turn's own window, for turns longer than MIN_TURN_MS only.
    const now = await $.clock.now()
    const inTurn = samples.filter(s => s.t >= now - e.durationMs)
    const cpu =
      e.durationMs > MIN_TURN_MS && inTurn.length > 0
        ? {
            avg: Math.round(inTurn.reduce((sum, s) => sum + s.v, 0) / inTurn.length),
            peak: Math.round(Math.max(...inTurn.map(s => s.v))),
            sampleCount: inTurn.length,
            hotSamples: inTurn.filter(s => s.v >= CPU_HOT_PERCENT).length,
            ...downsample(inTurn),
          }
        : null

    // Free RAM and paging over the same window and for the same turns.
    const mem =
      e.durationMs > MIN_TURN_MS && inTurn.length > 0
        ? {
            avg: gb(mean(inTurn.map(s => s.m)) ?? 0),
            min: gb(Math.min(...inTurn.map(s => s.m))),
            pagesPeak: Math.round(Math.max(...inTurn.map(s => s.p))),
          }
        : null

    const session =
      total === 0
        ? null
        : {
            percent: Math.round((hot / total) * 100),
            minutes: Math.round((hot * SAMPLE_SECONDS) / 60),
          }

    const turn: TurnCost = {
      cpu,
      mem,
      hot: session,
      context:
        context.tokens === undefined
          ? null
          : { tokens: count(context.tokens), percent: context.percent ?? null },
      duration: duration(e.durationMs),
      model: u === undefined ? null : modelName(u.model),
      effort: u === undefined ? null : turnEffort,
      tokens:
        u === undefined
          ? null
          : {
              input: count(u.input_tokens),
              output: count(u.output_tokens),
              read: count(u.cache_read_input_tokens),
              write: count(u.cache_creation_input_tokens),
            },
      reason: e.reason,
    }
    await update($, last, () => turn)

    // The per-turn log: one JSON line per finished turn, one file per month.
    try {
      const start = now - e.durationMs
      const mine = toolSpans.filter(s => s[1] > start)
      const spans = merge(
        mine.map(s => [Math.max(s[0], start), Math.min(s[1], now)] as [number, number]),
      )
      toolSpans = []

      const toolMs = spans.reduce((sum, s) => sum + (s[1] - s[0]), 0)
      const inTool = inTurn.filter(s => spans.some(([a, b]) => s.t >= a && s.t <= b))
      const load = (list: Sample[]) => list.map(s => s.v)
      const queue = (list: Sample[]) => list.map(s => s.q)
      const hotMs = (list: Sample[]) =>
        list.filter(s => s.v >= CPU_HOT_PERCENT).length * SAMPLE_SECONDS * 1000

      const sessionId = await $.session.id()
      const cwd = await $.session.cwd()
      const home = await $.env.get('USERPROFILE')

      // The engine keeps a session's title beside its transcript:
      // ~/.claude/projects/<cwd with non-alphanumerics as "-">/<id>/custom-title.json
      let sessionTitle = title

      if (home !== undefined) {
        try {
          const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
          const raw = await $.fs.read(
            `${home}\\.claude\\projects\\${slug}\\${sessionId}\\custom-title.json`,
          )

          if (typeof raw === 'string') {
            const parsed = JSON.parse(raw) as { customTitle?: string }
            sessionTitle = parsed.customTitle ?? sessionTitle
          }
        } catch {
          // No title file (yet): keep what the hooks reported, or null.
        }
      }

      const entry = {
        ts: new Date(now).toISOString(),
        session_id: sessionId,
        session_title: sessionTitle,
        project: cwd,
        model: u === undefined ? null : u.model,
        effort: turnEffort,
        reason: e.reason,
        duration_ms: e.durationMs,
        tool_ms: toolMs,
        tool_calls: mine.length,
        model_ms: Math.max(0, e.durationMs - toolMs),
        samples: inTurn.length,
        cpu_avg: round1(mean(load(inTurn))),
        cpu_peak: round1(peakOf(load(inTurn))),
        hot_ms: hotMs(inTurn),
        queue_avg: round1(mean(queue(inTurn))),
        queue_peak: peakOf(queue(inTurn)),
        tool_samples: inTool.length,
        tool_cpu_avg: round1(mean(load(inTool))),
        tool_cpu_peak: round1(peakOf(load(inTool))),
        tool_hot_ms: hotMs(inTool),
        tool_queue_avg: round1(mean(queue(inTool))),
        tool_queue_peak: peakOf(queue(inTool)),
        mem_free_avg_mb: round1(mean(inTurn.map(s => s.m))),
        mem_free_min_mb: inTurn.length === 0 ? null : Math.min(...inTurn.map(s => s.m)),
        pages_avg: round1(mean(inTurn.map(s => s.p))),
        pages_peak: peakOf(inTurn.map(s => s.p)),
        tool_mem_free_min_mb:
          inTool.length === 0 ? null : Math.min(...inTool.map(s => s.m)),
        tool_pages_peak: peakOf(inTool.map(s => s.p)),
        cores: Number(await $.env.get('NUMBER_OF_PROCESSORS')) || null,
        input_tokens: u === undefined ? null : u.input_tokens,
        output_tokens: u === undefined ? null : u.output_tokens,
        cache_read_tokens: u === undefined ? null : u.cache_read_input_tokens,
        cache_write_tokens: u === undefined ? null : u.cache_creation_input_tokens,
      }

      if (home !== undefined) {
        const path =`${home}\\.claude\\turn-monitor\\log-${entry.ts.slice(0, 7)}.jsonl`
        const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : ''

        await $.fs.write(
          path,
          `${typeof previous === 'string' ? previous : ''}${JSON.stringify(entry)}\n`,
        )
      }
    } catch (error) {
      // A log problem must not break the band; say so once.
      if (!isLogFailureShown) {
        isLogFailureShown = true
        $.ui.log(`turn-monitor: the turn log could not be written (${String(error)})`)
      }
    }

    // The same figures as one plain, dim line in the transcript. (The
    // turn.complete text was tried instead: the engine folds it into a collapsed
    // notice with every contributing plugin's name in front.)
    $.ui.log(plainLine(turn))

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const turn = await read($, last)

    if (e.props.hasSurvey) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const open = await read($, isOpen)

    // While the next turn runs the figures are still the previous turn's: the
    // band is drawn dim behind a label, so nobody reads them as live.
    const stale = e.props.isWorking

    // Nothing has finished since the mod loaded (a reload starts the band empty).
    if (turn === null) {
      return (
        <Box>
          <Text dimColor>turn-monitor: figures appear after the next finished turn</Text>
        </Box>
      )
    }

    if (turn.tokens === null) {
      return (
        <Box>
          {stale && (
            <Text dimColor>
              {STALE_LABEL}
              {GAP}
            </Text>
          )}
          <Text color={TIME} dimColor={stale}>
            {turn.duration}
          </Text>
          <Text dimColor>  no tokens recorded ({turn.reason})</Text>
        </Box>
      )
    }

    const t = turn.tokens

    const cpu = turn.cpu

    return (
      <Box flexDirection="column">
        <Box>
        {stale && (
          <Text dimColor>
            {STALE_LABEL}
            {GAP}
          </Text>
        )}
        <Text color={MODEL} dimColor={stale}>
          {modelLabel(turn)}
          {GAP}
        </Text>
        <Text color={TIME} dimColor={stale}>
          {turn.duration}
          {GAP}
        </Text>
        {turn.context !== null && (
          <Text
            color={isHigh(turn.context.percent) ? CONTEXT_HIGH : CONTEXT}
            bold={isHigh(turn.context.percent)}
            dimColor={stale}
          >
            ctx:{turn.context.tokens}
            {turn.context.percent === null ? '' : ` ${turn.context.percent}%`}
            {isHigh(turn.context.percent) ? ' !!!' : ''}
            {GAP}
          </Text>
        )}
        <Text color={INPUT} dimColor={stale}>
          cw:{t.write} in:{t.input} cr:{t.read}
          {GAP}
        </Text>
        <Text color={OUTPUT} dimColor={stale}>
          out:{t.output}
        </Text>
        {cpu !== null && (
          <Text color={CPU} dimColor={stale}>
            {GAP}cpu:{cpu.avg}% ({cpu.peak}%
            <Text color={HOT} dimColor={stale}>
              , {hotShare(cpu)}%
            </Text>
            )
          </Text>
        )}
        {turn.mem !== null && (
          <Text color={MEM} dimColor={stale}>
            {GAP}free:{turn.mem.avg} ({turn.mem.min})
          </Text>
        )}
        {cpu !== null && cpu.points.length > 1 && (
          <Box>
            <Text> </Text>
            <Button
              key="cpu-toggle"
              label={open ? '▾' : '▸'}
              onPress={() => update($, isOpen, current => !current)}
            />
          </Box>
        )}
        </Box>
        {cpu !== null && cpu.points.length > 1 && open && (
          <Box flexDirection="column">
            <Text color={CPU} dimColor={stale}>
              CPU during the turn: {clock(cpu.times[0] ?? 0)} to{' '}
              {clock(cpu.times[cpu.times.length - 1] ?? 0)}, avg {cpu.avg}%, peak{' '}
              {cpu.peak}%
            </Text>
            <Text color={HOT} dimColor={stale}>
              At {CPU_HOT_PERCENT}%+ this turn:{' '}
              {hotShare(cpu)}% (
              {hotTime(cpu.hotSamples)}), session: {turn.hot?.percent ?? 0}% (
              {turn.hot?.minutes ?? 0}m)
            </Text>
            {turn.mem !== null && (
              <Text color={MEM} dimColor={stale}>
                Free RAM during the turn: avg {turn.mem.avg}, min {turn.mem.min}, paging
                peak {turn.mem.pagesPeak}/s
              </Text>
            )}
            {Svg !== undefined && (
              <Svg
                source={sparkline(cpu.points, cpu.peaks ?? [], cpu.times)}
                alt={`CPU load during the turn, ${cpu.points.length} bars`}
                width={GRAPH_W}
                height={GRAPH_H}
                isInteractive
              />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
