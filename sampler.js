/**
 * 速度采样器（纯逻辑，无 IO、无定时器）
 *
 * 输入：llm/stream 的 chunk 与到达时刻；输出：一帧速度快照。
 *
 * 口径：
 *  - chunk 不等于 token（一个 chunk 常是 2~3 个字符，还会成串到达），
 *    所以实时速度按「字符率 ÷ 每 token 字符数」估算；
 *  - 每 token 字符数随内容变化很大，用 usage 的 outputTokens 在线标定；
 *  - 官方 outputTokens 落定后计入累计值，总输出以它为准。
 *
 * 时间统一用毫秒整数，窗口是滑动字符窗口，不依赖固定采样节拍。
 */

const WINDOW_INSTANT = 350
const WINDOW_SHORT = 1000
const WINDOW_LONG = 5000
const KEEP_MS = WINDOW_LONG + 1500
const ACTIVE_MS = 1200
/** 先验：实测 deepseek-flash 混合内容约 2.6~6 字符/token，取偏保守的 3.2。 */
const PRIOR_RATIO = 3.2
/** 标定样本过滤：太小的尝试（几十个字符）信噪比低，不参与。 */
const MIN_SAMPLE_CHARS = 120
const MIN_SAMPLE_TOKENS = 20

function sumChars(events, since) {
  let chars = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.t < since) break
    chars += event.chars
  }
  return chars
}

function trim(events, oldest) {
  let drop = 0
  while (drop < events.length && events[drop].t < oldest) drop += 1
  if (drop > 0) events.splice(0, drop)
}

/** 每个模型一条 ratio 记忆；跨会话共享。 */
class RatioStore {
  constructor() {
    this.ratios = new Map()
    this.samples = new Map()
  }

  key(provider, model) {
    return `${provider || '?'}/${model || '?'}`
  }

  get(provider, model) {
    return this.ratios.get(this.key(provider, model)) ?? PRIOR_RATIO
  }

  /** 用一次已完成的尝试（字符数 + 官方 outputTokens）修正 ratio。 */
  observe(provider, model, chars, outputTokens) {
    if (!(chars >= MIN_SAMPLE_CHARS) || !(outputTokens >= MIN_SAMPLE_TOKENS)) return null
    const sample = chars / outputTokens
    if (!Number.isFinite(sample) || sample <= 0.15 || sample > 30) return null
    const key = this.key(provider, model)
    const prev = this.ratios.get(key)
    // 首次直接采用样本；此后指数滑动，慢慢跟住内容形态的变化。
    const next = prev === undefined ? sample : prev * 0.7 + sample * 0.3
    this.ratios.set(key, next)
    const count = (this.samples.get(key) || 0) + 1
    this.samples.set(key, count)
    return { ratio: next, sample, count }
  }

  /** 已标定的模型数 / 平均 ratio（给快照做展示用）。 */
  summary() {
    if (this.ratios.size === 0) return { calibrated: 0, mean: PRIOR_RATIO }
    let total = 0
    for (const value of this.ratios.values()) total += value
    return { calibrated: this.ratios.size, mean: total / this.ratios.size }
  }
}

export class SpeedSampler {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.ratios = new RatioStore()
    this.events = []
    this.streams = new Map()
    this.seq = 0
    this.peak = 0
    this.peakAt = 0
    this.lastExact = null
    this.totalChars = 0
    // 官方 usage 落定的部分（精确）与无 usage 流的兜底估算
    this.settledTokens = 0
    this.settledChars = 0
    this.fallbackTokens = 0
    this.fallbackChars = 0
  }

  /** 开一次模型调用观察。meta: {sessionId, provider, model, purpose, title} */
  begin(meta = {}) {
    const id = ++this.seq
    const at = this.now()
    const stream = {
      id,
      sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
      provider: meta.provider || null,
      model: meta.model || null,
      title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : null,
      aux: meta.purpose === 'compaction' || meta.purpose === 'session-title',
      startedAt: at,
      firstTokenAt: null,
      lastChunkAt: null,
      endedAt: null,
      chars: 0,
      chunks: 0,
      events: [],
      exactTokens: null,
      exactMs: null,
      exactTps: null,
      error: null,
    }
    this.streams.set(id, stream)
    return { id, push: (chunk) => this.push(stream, chunk), end: (error) => this.end(stream, error) }
  }

  /** 给还在跑的流补/刷标题（标题可能在流开始之后才生成）。 */
  refreshTitles(resolver) {
    if (typeof resolver !== 'function') return 0
    let updated = 0
    for (const stream of this.streams.values()) {
      if (stream.endedAt !== null || !stream.sessionId) continue
      try {
        const title = resolver(stream.sessionId)
        if (typeof title === 'string' && title.length > 0 && title !== stream.title) {
          stream.title = title.slice(0, 80)
          updated += 1
        }
      } catch {}
    }
    return updated
  }

  push(stream, chunk) {
    if (!stream || !chunk) return
    const type = chunk.type
    let len = 0
    if (type === 'text-delta' || type === 'reasoning-delta') len = String(chunk.text ?? '').length
    else if (type === 'tool-call-delta') len = String(chunk.argumentsDelta ?? '').length
    else if (type === 'usage') {
      this.usage(stream, chunk.usage ?? chunk)
      return
    } else return

    if (len <= 0) return
    const at = this.now()
    if (stream.firstTokenAt === null) stream.firstTokenAt = at
    stream.lastChunkAt = at
    stream.chunks += 1
    stream.chars += len
    stream.events.push({ t: at, chars: len })
    this.events.push({ t: at, chars: len })
    this.totalChars += len
    trim(stream.events, at - KEEP_MS)
    trim(this.events, at - KEEP_MS)
  }

  usage(stream, usage) {
    if (!stream || !usage) return
    const outputTokens = Number(usage.outputTokens)
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) return
    const settleAt = this.now()
    const first = stream.firstTokenAt
    const decodeMs = first === null ? 0 : Math.max(0, settleAt - first)
    stream.exactTokens = outputTokens
    stream.exactMs = decodeMs
    stream.exactTps = decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null
    // 官方 outputTokens 一旦拿到就锁进累计值：之后"总输出"只增不减，不会被 ratio 变化回算
    if (!stream.usageSeen) {
      stream.usageSeen = true
      this.settledTokens += outputTokens
      this.settledChars += stream.chars
    }
    const observed = this.ratios.observe(stream.provider, stream.model, stream.chars, outputTokens)
    const ratio = observed ? observed.ratio : this.ratios.get(stream.provider, stream.model)
    this.lastExact = {
      at: settleAt,
      tps: stream.exactTps === null ? null : Math.round(stream.exactTps * 10) / 10,
      tokens: outputTokens,
      chars: stream.chars,
      ms: decodeMs,
      ratio: Math.round(ratio * 100) / 100,
      calibrated: observed ? Math.round(observed.sample * 100) / 100 : null,
      sampleCount: observed ? observed.count : null,
      model: stream.model,
      sessionId: stream.sessionId,
      aux: stream.aux,
    }
  }

  end(stream, error) {
    if (!stream) return
    stream.endedAt = this.now()
    if (error) stream.error = String(error && error.message ? error.message : error)
    // 没有 usage 的流（中断/插件没透传）按 ratio 兜底计入一次，避免总输出漏掉
    if (!stream.usageSeen && !stream.fallbackSeen) {
      stream.fallbackSeen = true
      const ratio = this.ratios.get(stream.provider, stream.model) || PRIOR_RATIO
      this.fallbackChars += stream.chars
      this.fallbackTokens += stream.chars / ratio
    }
    trim(stream.events, stream.endedAt - KEEP_MS)
  }

  /** 清掉早已结束的观察记录，避免长会话里 Map 无限膨胀。 */
  sweep(now) {
    if (this.streams.size <= 64) return
    for (const [id, stream] of this.streams) {
      if (stream.endedAt !== null && now - stream.endedAt > 60_000) this.streams.delete(id)
    }
  }

  /** 生成一帧速度快照。t 由调用方给（同一帧内共享同一时刻）。 */
  frame(t = this.now()) {
    trim(this.events, t - KEEP_MS)
    const instantChars = sumChars(this.events, t - WINDOW_INSTANT)
    const shortChars = sumChars(this.events, t - WINDOW_SHORT)
    const longChars = sumChars(this.events, t - WINDOW_LONG)
    const summary = this.ratios.summary()
    // 聚合帧用一个全局 ratio；有多个模型的混合流时它只是近似，但趋势正确。
    const ratio = summary.mean
    const instant = instantChars / ratio / (WINDOW_INSTANT / 1000)
    const short = shortChars / ratio / (WINDOW_SHORT / 1000)
    const long = longChars / ratio / (WINDOW_LONG / 1000)
    if (short > this.peak) {
      this.peak = short
      this.peakAt = t
    }

    const rows = []
    let active = 0
    let aux = 0
    for (const stream of this.streams.values()) {
      const last = stream.lastChunkAt ?? stream.endedAt
      const live = stream.endedAt === null && last !== null && t - last <= ACTIVE_MS
      if (!live) continue
      if (stream.aux) aux += 1
      else active += 1
      trim(stream.events, t - KEEP_MS)
      const streamRatio = this.ratios.get(stream.provider, stream.model)
      const streamInstant = sumChars(stream.events, t - WINDOW_INSTANT) / streamRatio / (WINDOW_INSTANT / 1000)
      const streamShort = sumChars(stream.events, t - WINDOW_SHORT) / streamRatio / (WINDOW_SHORT / 1000)
      rows.push({
        id: stream.sessionId ? stream.sessionId.slice(-8) : `#${stream.id}`,
        title: stream.title || null,
        model: stream.model,
        inst: Math.round(streamInstant * 10) / 10,
        short: Math.round(streamShort * 10) / 10,
        chars: stream.chars,
        tokens: Math.round(stream.chars / streamRatio),
        ms: stream.startedAt === null ? 0 : t - stream.startedAt,
        ttft: stream.firstTokenAt === null ? null : stream.firstTokenAt - stream.startedAt,
        lastTps: stream.exactTps === null ? null : Math.round(stream.exactTps * 10) / 10,
        aux: stream.aux,
      })
    }
    rows.sort((a, b) => b.inst - a.inst)

    this.sweep(t)
    // 总输出 = 官方 usage 累计 + 无 usage 流的兜底 + 还在飞的字符按当前 ratio 估算
    const pendingChars = Math.max(0, this.totalChars - this.settledChars - this.fallbackChars)
    const tokensEst = Math.round(this.settledTokens + this.fallbackTokens + pendingChars / ratio)
    return {
      v: 1,
      t,
      ratio: Math.round(ratio * 100) / 100,
      calibrated: summary.calibrated,
      inst: Math.round(instant * 10) / 10,
      w1: Math.round(short * 10) / 10,
      w5: Math.round(long * 10) / 10,
      peak: Math.round(this.peak * 10) / 10,
      peakAt: this.peakAt,
      active,
      aux,
      chars: this.totalChars,
      tokensEst,
      exactTokens: Math.round(this.settledTokens),
      streams: rows.slice(0, 4),
      last: this.lastExact,
    }
  }

  /** 换会话/重置时清掉累计值。 */
  reset() {
    this.events.length = 0
    this.streams.clear()
    this.peak = 0
    this.peakAt = 0
    this.lastExact = null
    this.totalChars = 0
    this.settledTokens = 0
    this.settledChars = 0
    this.fallbackTokens = 0
    this.fallbackChars = 0
  }
}

export const CONSTANTS = { WINDOW_INSTANT, WINDOW_SHORT, WINDOW_LONG, PRIOR_RATIO }
