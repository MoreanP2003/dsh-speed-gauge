// host 半集成测试：用假 ctx 把路由与 llm/stream 观察者接到一起跑一遍。
// 跑法：node --test C:\dev\dsh-lab\speed-gauge\test\host.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../host.js'

function makeContext() {
  const routes = new Map()
  const listeners = new Map()
  const data = { routes, listeners }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      data.disposer = disposer
      return () => {}
    },
    on(event, handler, options) {
      listeners.set(event, { handler, options })
    },
    // 标题服务：index.js 通过 ctx.get('sessions'/'sessionTitle') 取标题。
    get(name) {
      if (name === 'sessions') return { get: (id) => (String(id).startsWith('sess-') ? { id } : undefined) }
      if (name === 'sessionTitle') return { get: () => ({ title: '测试会话标题', source: 'fallback' }) }
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, data }
}

function fakeRes() {
  const state = { status: 0, headers: null, chunks: [], ended: false }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers || null; return this },
    flushHeaders() {},
    write(chunk) { state.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk) state.chunks.push(String(chunk)); state.ended = true },
    destroy() {},
  }
}

function fakeReq(method = 'GET') {
  const handlers = new Map()
  return {
    method,
    on(event, cb) {
      handlers.set(event, cb)
      // 路由里 await readBody(req) 需要 end 事件；假请求立刻补一个。
      if (event === 'end') setTimeout(() => { const fn = handlers.get('end'); if (fn) fn() }, 0)
      return this
    },
    destroy() {},
    emit(event) { const cb = handlers.get(event); if (cb) cb() },
  }
}

function frames(res) {
  const out = []
  for (const chunk of res.state.chunks) {
    if (chunk.startsWith('data: ')) {
      try { out.push(JSON.parse(chunk.slice(6))) } catch (e) {}
    }
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('注册四条路由，SSE 能收到逐帧快照', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  assert.deepEqual([...data.routes.keys()].sort(), [
    '/api/dsh-speed-gauge/panel-worker.js',
    '/api/dsh-speed-gauge/reset',
    '/api/dsh-speed-gauge/snapshot',
    '/api/dsh-speed-gauge/stream',
  ])
  const res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/stream').handler(fakeReq('GET'), res)
  assert.equal(res.state.status, 200)
  assert.match(res.state.headers['content-type'], /text\/event-stream/)
  await sleep(80)
  const received = frames(res)
  assert.ok(received.length >= 2, '应至少收到 2 帧，实际 ' + received.length)
  assert.equal(typeof received[received.length - 1].inst, 'number')
})

test('llm/stream 观察者：透明转发 + 记账 + usage 精确口径', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  const hook = data.listeners.get('llm/stream')
  assert.ok(hook, '必须挂上 llm/stream')
  assert.deepEqual(hook.options, { global: true })

  const chunks = [
    { type: 'block-start', blockType: 'text' },
    { type: 'text-delta', text: 'a'.repeat(200) },
    { type: 'text-delta', text: 'b'.repeat(200) },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 100 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  let consumed = 0
  async function* source() {
    for (const chunk of chunks) {
      consumed += 1
      yield chunk
      await sleep(5)
    }
  }
  const wrapped = hook.handler({ sessionId: 'sess-12345678', provider: 'p', model: 'm', purpose: undefined }, () => source())
  assert.ok(wrapped && typeof wrapped[Symbol.asyncIterator] === 'function', '必须返回 AsyncIterable')

  const seen = []
  for await (const chunk of wrapped) seen.push(chunk)
  assert.deepEqual(seen, chunks, '必须原样、按序转发所有 chunk')
  assert.equal(consumed, chunks.length)

  const res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/snapshot').handler(fakeReq('GET'), res)
  const snapshot = JSON.parse(res.state.chunks.join(''))
  assert.ok(snapshot.chars >= 400, '应累计 400 个字符，实际 ' + snapshot.chars)
  assert.ok(snapshot.ratio > 0)
  assert.equal(snapshot.last.tokens, 100)
  assert.ok(snapshot.last.ms >= 0)
  // 精确口径 = outputTokens / 解码毫秒；这里解码窗口很短，只校验自洽性。
  assert.ok(Math.abs(snapshot.last.tps - snapshot.last.tokens / (snapshot.last.ms / 1000)) < 1)
})

test('下游异常原样抛出，不让 observer 把错误吞掉', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  const hook = data.listeners.get('llm/stream')
  async function* broken() {
    yield { type: 'text-delta', text: 'x' }
    throw new Error('provider blew up')
  }
  const wrapped = hook.handler({ sessionId: 's', provider: 'p', model: 'm' }, () => broken())
  await assert.rejects(async () => {
    for await (const _chunk of wrapped) { /* drain */ }
  }, /provider blew up/)
})

test('辅助调用被标 aux，不进入主生成计数', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  const hook = data.listeners.get('llm/stream')
  async function* titleStream() {
    yield { type: 'text-delta', text: 'y'.repeat(60) }
    await sleep(20)
  }
  const wrapped = hook.handler({ sessionId: 's', provider: 'p', model: 'm', purpose: 'session-title' }, () => titleStream())
  const drain = (async () => { for await (const _c of wrapped) {} })()
  await sleep(30)
  await drain
  const res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/snapshot').handler(fakeReq('GET'), res)
  const snapshot = JSON.parse(res.state.chunks.join(''))
  assert.ok(snapshot.chars >= 60)
  assert.equal(snapshot.active, 0)
})

test('reset 路由清空峰值', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  const hook = data.listeners.get('llm/stream')
  async function* burst() {
    yield { type: 'text-delta', text: 'z'.repeat(700) }
  }
  const wrapped = hook.handler({ sessionId: 's', provider: 'p', model: 'm' }, () => burst())
  for await (const _c of wrapped) { /* drain */ }
  await sleep(40)
  let res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/snapshot').handler(fakeReq('GET'), res)
  const before = JSON.parse(res.state.chunks.join(''))
  assert.ok(before.peak > 0, '应先有峰值')

  res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/reset').handler(fakeReq('POST'), res)
  assert.equal(res.state.status, 204)
  res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/snapshot').handler(fakeReq('GET'), res)
  const after = JSON.parse(res.state.chunks.join(''))
  assert.equal(after.peak, 0)
  assert.equal(after.chars, 0)
})

test('apply 绝不抛异常（就算 ctx 缺服务）', () => {
  assert.doesNotThrow(() => apply({ on() {}, effect() {}, webServer: { register() { throw new Error('no route seat') } } }))
  assert.doesNotThrow(() => apply({}))
})

test('非回环请求被 403 拒绝', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  const res = fakeRes()
  const req = fakeReq('GET')
  req.socket = { remoteAddress: '192.168.1.20' }
  await data.routes.get('/api/dsh-speed-gauge/snapshot').handler(req, res)
  assert.equal(res.state.status, 403)
})

test('会话行带任务标题：从 ctx.get(sessions/sessionTitle) 取', async () => {
  const { ctx, data } = makeContext()
  apply(ctx)
  const hook = data.listeners.get('llm/stream')
  async function* slow() {
    yield { type: 'text-delta', text: 'x'.repeat(40) }
    await sleep(400)
  }
  const wrapped = hook.handler({ sessionId: 'sess-abcdef12', provider: 'p', model: 'deepseek-flash' }, () => slow())
  const drain = (async () => { for await (const _chunk of wrapped) { /* drain */ } })()
  await sleep(120)
  const res = fakeRes()
  await data.routes.get('/api/dsh-speed-gauge/snapshot').handler(fakeReq('GET'), res)
  const snapshot = JSON.parse(res.state.chunks.join(''))
  assert.ok(snapshot.streams.length >= 1, '应有活跃会话行')
  assert.equal(snapshot.streams[0].title, '测试会话标题')
  assert.equal(snapshot.streams[0].model, 'deepseek-flash')
  assert.equal(snapshot.streams[0].id, 'abcdef12') // 代号仍在载荷里，只是界面改用标题
  await drain
})
