/**
 * 生成速度仪表盘 · 服务端
 *
 * 1. 挂 llm/stream 观察每次模型调用，按 chunk 记字符数，拿到 usage 时标定 chars/token。
 * 2. 通过 SSE 推送快照（活跃 50Hz，空闲 5Hz）。
 * 3. 提供 snapshot / reset 路由，SSE 不可用时客户端退化为轮询。
 *
 * 观察者必须透明：不吞 chunk、不改顺序、不接管取消，自身异常一律吞掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SpeedSampler } from './sampler.js'

export const name = 'dsh-speed-gauge'
export const inject = ['webServer']

/** 活跃期出帧间隔（50Hz）。这是“帧率”的数字来源，客户端会把它显示出来。 */
const FRAME_MS = 20
/** 空闲期出帧间隔（5Hz）：保持连接活着，又不在没人看的时候空转。 */
const IDLE_MS = 200
/** 一次尝试的精确口径落盘，便于事后核对（超过上限自动轮转）。 */
const LOG_LIMIT = 256 * 1024

const HERE = path.dirname(fileURLToPath(import.meta.url))

const sampler = new SpeedSampler()
// 按会话隔离：每个会话一个采样器（没有 sessionId 的调用落到全局 sampler 上）
const sessionSamplers = new Map()
const sessionTouched = new Map()

function samplerFor(sessionId) {
  if (!sessionId) return sampler
  let s = sessionSamplers.get(sessionId)
  if (!s) {
    s = new SpeedSampler()
    sessionSamplers.set(sessionId, s)
  }
  sessionTouched.set(sessionId, Date.now())
  return s
}

/** 没指定会话时的兜底：取最近有活动的那个会话；没有任何会话就用全局。 */
function activeSampler() {
  let best = null
  let bestId = null
  let bestAt = 0
  for (const [id, at] of sessionTouched) {
    if (at > bestAt) {
      bestAt = at
      bestId = id
      best = sessionSamplers.get(id) || null
    }
  }
  if (!best) return { sampler, id: null }
  return { sampler: best, id: bestId }
}

function sessionFromUrl(req) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const v = url.searchParams.get('session')
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

/** 已连接的 SSE 客户端；每项 { res, closed }。 */
const clients = new Set()
let timer = null
let timerMs = 0
let framesSent = 0
let frameErrors = 0
let lastExactSeen = null
let lastTitleRefresh = 0

/** sessionId → { title, at }；标题两秒一查，够跟上标题生成又不拖慢 50Hz 出帧。 */
const titleCache = new Map()
let ctxRef = null

/**
 * 从会话服务查标题。`sessionTitle` 是 DSH 的标题服务，get(session) 返回
 * {title, source}；查不到（会话还没标题/不是实时会话）时返回 null，界面上回退到模型名。
 */
function resolveTitle(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const now = Date.now()
  const cached = titleCache.get(sessionId)
  if (cached && now - cached.at < 2000) return cached.title
  let title = null
  try {
    const sessions = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('sessions') : null
    const titles = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('sessionTitle') : null
    if (sessions && titles) {
      const session = sessions.get(sessionId)
      if (session) {
        const snapshot = titles.get(session)
        if (snapshot && typeof snapshot.title === 'string' && snapshot.title.length > 0) {
          title = snapshot.title.slice(0, 80)
        }
      }
    }
  } catch {}
  if (title === null) title = cached ? cached.title : null
  titleCache.set(sessionId, { at: now, title })
  if (titleCache.size > 200) {
    const oldest = [...titleCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
    for (const [key] of oldest) titleCache.delete(key)
  }
  return title
}

// 采样日志默认关闭：插件目录在别的环境里可能是只读的，不能依赖可写本地路径。
// 需要排查时设 DSH_SPEED_GAUGE_LOG=1，日志写到系统临时目录。
const ATTEMPT_LOG = process.env.DSH_SPEED_GAUGE_LOG === '1'
  ? path.join(os.tmpdir(), 'dsh-speed-gauge-attempts.jsonl')
  : null

function logAttempt(row) {
  if (!ATTEMPT_LOG) return
  try {
    if (fs.existsSync(ATTEMPT_LOG) && fs.statSync(ATTEMPT_LOG).size > LOG_LIMIT) {
      fs.renameSync(ATTEMPT_LOG, ATTEMPT_LOG + '.1')
    }
    fs.appendFileSync(ATTEMPT_LOG, JSON.stringify(row) + '\n')
  } catch {}
}

function frame(sessionId) {
  const now = Date.now()
  let s = sampler
  let sId = sessionId || null
  if (sessionId) {
    s = samplerFor(sessionId)
  } else {
    const active = activeSampler()
    s = active.sampler
    sId = active.id
  }
  if (now - lastTitleRefresh > 2000) {
    lastTitleRefresh = now
    try { s.refreshTitles(resolveTitle) } catch {}
  }
  const snapshot = s.frame(now)
  const frameNo = ++framesSent
  return { ...snapshot, session: sId, frame: frameNo, hz: Math.round(1000 / timerMs) || 0 }
}

function broadcast() {
  if (clients.size === 0) {
    stopTimer()
    return
  }
  let snapshot
  try {
    snapshot = frame()
  } catch (error) {
    frameErrors += 1
    return
  }
  // 页面里的"当前会话"参数：客户端带上 ?session=xxx 时就按会话统计
  if (snapshot.last && snapshot.last !== lastExactSeen) {
    lastExactSeen = snapshot.last
    logAttempt({ at: Date.now(), ...snapshot.last, ratioNow: snapshot.ratio, calibrated: snapshot.calibrated })
  }
  const idle = snapshot.active === 0 && snapshot.aux === 0
  const wanted = idle ? IDLE_MS : FRAME_MS
  if (wanted !== timerMs) restartTimer(wanted)
  // 每个客户端可以订阅自己的会话；按会话缓存本帧，避免重复计算。
  const cache = new Map()
  for (const client of clients) {
    try {
      if (client.closed) { clients.delete(client); continue }
      const key = client.sessionId || ''
      let body = cache.get(key)
      if (!body) {
        const snap = client.sessionId ? frame(client.sessionId) : snapshot
        body = 'data: ' + JSON.stringify(snap) + '\n\n'
        cache.set(key, body)
      }
      client.res.write(body)
    } catch {
      client.closed = true
      clients.delete(client)
      try { client.res.destroy() } catch {}
    }
  }
}

function restartTimer(ms) {
  stopTimer()
  timerMs = ms
  try {
    timer = setInterval(broadcast, ms)
    timer.unref?.()
  } catch {
    timer = null
  }
}

function stopTimer() {
  if (timer !== null) {
    try { clearInterval(timer) } catch {}
    timer = null
    timerMs = 0
  }
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    try {
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > limit) { finish(null); try { req.destroy() } catch {} ; return }
        chunks.push(chunk)
      })
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => finish(null))
    } catch { finish(null) }
  })
}

/**
 * 自定义 exact 路由绕过 /api 桥的登录校验，所以默认只对回环地址提供服务。
 * 走网页版（远程访问、反向代理）时设 DSH_SPEED_GAUGE_ALLOW_REMOTE=1 放开，
 * 此时依赖宿主自身的访问控制。
 */
function fromLoopback(req) {
  if (process.env.DSH_SPEED_GAUGE_ALLOW_REMOTE === '1') return true
  try {
    const address = req.socket && req.socket.remoteAddress
    if (!address) return true
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  } catch {
    return true
  }
}

function guard(req, res) {
  if (fromLoopback(req)) return false
  try { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('loopback only') } catch {}
  return true
}

export function apply(ctx) {
  ctxRef = ctx
  try {
    // ---- SSE：主通道。桌面端实测可真正流式（不会被 IPC bridge 缓冲） ----
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-speed-gauge/stream',
      handler: async (req, res) => {
        try {
          if (guard(req, res)) return
          if (req.method !== 'GET') { res.writeHead(405).end(); return }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          res.flushHeaders?.()
          const client = { res, closed: false, since: Date.now(), sessionId: sessionFromUrl(req) }
          clients.add(client)
          try {
            res.write(': dsh-speed-gauge ready\n\n')
            res.write('retry: 1000\n\n')
            res.write('data: ' + JSON.stringify(frame(client.sessionId)) + '\n\n')
          } catch {}
          // 首帧立刻给，之后交给 broadcast。空闲/活跃的节拍切换也只在这里发生。
          if (timer === null) restartTimer(FRAME_MS)
          req.on('close', () => {
            client.closed = true
            clients.delete(client)
            if (clients.size === 0) stopTimer()
          })
        } catch {
          try { res.destroy() } catch {}
        }
      },
    }, 'speed-gauge: sse'), 'speed-gauge: sse route')
  } catch (error) {
    try { console.warn('[dsh-speed-gauge] stream route failed:', error) } catch {}
  }

  // ---- 兜底：一次性快照（SSE 不可用时客户端退化为轮询） ----
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-speed-gauge/snapshot',
      handler: async (req, res) => {
        try {
          if (guard(req, res)) return
          if (req.method !== 'GET') { res.writeHead(405).end(); return }
          const body = JSON.stringify(frame(sessionFromUrl(req)))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
        } catch {
          try { res.writeHead(500).end('{}') } catch {}
        }
      },
    }, 'speed-gauge: snapshot'), 'speed-gauge: snapshot route')
  } catch {}

  // ---- 清空峰值 / 累计（仪表盘上的“重置”按钮） ----
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-speed-gauge/reset',
      handler: async (req, res) => {
        try {
          if (guard(req, res)) return
          if (req.method !== 'POST') { res.writeHead(405).end(); return }
          await readBody(req, 16 * 1024)
          sampler.peak = 0
          sampler.peakAt = 0
          sampler.reset()
          // 按会话隔离后，归零要把所有会话采样器一起清掉
          for (const s of sessionSamplers.values()) {
            s.peak = 0
            s.peakAt = 0
            try { s.reset() } catch {}
          }
          sessionTouched.clear()
          lastExactSeen = null
          res.writeHead(204).end()
        } catch {
          try { res.writeHead(500).end() } catch {}
        }
      },
    }, 'speed-gauge: reset'), 'speed-gauge: reset route')
  } catch {}

  // ---- 曲线渲染 Worker（OffscreenCanvas）：主线程卡顿时曲线仍能独立绘制 ----
  try {
    const WORKER_FILE = path.join(HERE, 'panel-worker.js')
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-speed-gauge/panel-worker.js',
      handler: async (req, res) => {
        try {
          if (guard(req, res)) return
          if (req.method !== 'GET') { res.writeHead(405).end(); return }
          const body = await fs.promises.readFile(WORKER_FILE)
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          }).end(body)
        } catch {
          try { res.writeHead(404).end() } catch {}
        }
      },
    }, 'speed-gauge: chart worker'), 'speed-gauge: chart worker route')
  } catch {}

  // ---- 观察者：包一层 AsyncIterable，逐 chunk 记账后原样转交 ----
  try {
    ctx.on('llm/stream', (options, next) => {
      const source = next()
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') return source
      let handle = null
      try {
        handle = samplerFor(options?.sessionId).begin({
          sessionId: options?.sessionId,
          provider: options?.provider,
          model: options?.model,
          purpose: options?.purpose,
          title: resolveTitle(options?.sessionId),
        })
      } catch {
        handle = null
      }
      if (handle === null) return source
      const active = handle
      return (async function* () {
        try {
          for await (const chunk of source) {
            try { active.push(chunk) } catch {}
            yield chunk
          }
          try { active.end(null) } catch {}
        } catch (error) {
          try { active.end(error) } catch {}
          throw error
        }
      })()
    }, { global: true })
  } catch (error) {
    try { console.warn('[dsh-speed-gauge] llm/stream hook failed:', error) } catch {}
  }

  // ---- 卸载：关掉定时器与所有 SSE 连接 ----
  try {
    ctx.effect(() => () => {
      stopTimer()
      for (const client of clients) {
        try { client.closed = true; client.res.end() } catch {}
      }
      clients.clear()
    }, 'speed-gauge: teardown')
  } catch {}
}
