// 采样器单元测试：node --test C:\dev\dsh-lab\speed-gauge\test\sampler.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeedSampler } from '../sampler.js'

function clock() {
  let t = 1000
  return { now: () => t, set: (v) => { t = v }, tick: (d) => { t += d } }
}

test('字符率 → 估算速度：先验 ratio 3.2', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const stream = sampler.begin({ sessionId: 'session-abcdef1234', provider: 'p', model: 'm' })
  // 350ms 窗口内 35 个字符 → 35 / 3.2 / 0.35 ≈ 31.25
  c.set(1000)
  stream.push({ type: 'text-delta', text: 'x'.repeat(35) })
  const frame = sampler.frame(c.now())
  assert.equal(frame.inst, 31.3)
  assert.equal(frame.active, 1)
  assert.equal(frame.streams.length, 1)
  assert.equal(frame.streams[0].chars, 35)
})

test('超出一帧窗口后瞬时值归零，1s/5s 窗口仍保留', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const stream = sampler.begin({ provider: 'p', model: 'm' })
  c.set(1000)
  stream.push({ type: 'text-delta', text: 'y'.repeat(64) })
  c.tick(400)
  const frame = sampler.frame(c.now())
  assert.equal(frame.inst, 0)
  assert.ok(frame.w1 > 0)
  assert.ok(frame.w5 > 0)
})

test('usage 标定：ratio 采用样本，精确 tps = outputTokens / 解码时长', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const stream = sampler.begin({ provider: 'p', model: 'calib' })
  c.set(1000)
  stream.push({ type: 'text-delta', text: 'z'.repeat(400) })
  c.set(2000)
  stream.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 100 } })
  const frame = sampler.frame(c.now())
  assert.equal(frame.last.tokens, 100)
  assert.equal(frame.last.ratio, 4)
  assert.equal(frame.last.tps, 100) // 100 tokens / 1000ms
  assert.equal(frame.ratio, 4)
  assert.equal(frame.calibrated, 1)
  // 该模型此后用标定后的 ratio：2000ms 处的 400 字符不再进 350ms 窗口
  c.set(2100)
  const next = sampler.frame(c.now())
  assert.equal(next.tokensEst, 100)
})

test('标定样本过小不参与', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const stream = sampler.begin({ provider: 'p', model: 'tiny' })
  c.set(1000)
  stream.push({ type: 'text-delta', text: 'a'.repeat(10) })
  c.set(1100)
  stream.push({ type: 'usage', usage: { outputTokens: 4 } })
  const frame = sampler.frame(c.now())
  assert.equal(frame.calibrated, 0)
  assert.equal(frame.ratio, 3.2)
})

test('峰值保持与多个并发流的聚合', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const a = sampler.begin({ sessionId: 'aaaaaaaaaa', provider: 'p', model: 'm' })
  const b = sampler.begin({ sessionId: 'bbbbbbbbbb', provider: 'p', model: 'm' })
  c.set(1000)
  a.push({ type: 'reasoning-delta', text: 'r'.repeat(70) })
  b.push({ type: 'tool-call-delta', argumentsDelta: 't'.repeat(70) })
  const frame = sampler.frame(c.now())
  assert.equal(frame.active, 2)
  assert.equal(frame.streams.length, 2)
  assert.ok(frame.inst > 100)
  const peak = frame.peak
  c.set(2000)
  const later = sampler.frame(c.now())
  assert.equal(later.peak, peak) // 峰值不会被回落的瞬时值拉低
})

test('辅助调用（会话标题/压缩）不计入主生成', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const aux = sampler.begin({ provider: 'p', model: 'm', purpose: 'session-title' })
  c.set(1000)
  aux.push({ type: 'text-delta', text: 'q'.repeat(20) })
  const frame = sampler.frame(c.now())
  assert.equal(frame.active, 0)
  assert.equal(frame.aux, 1)
})

test('老事件会被裁掉，内存不随会话增长', () => {
  const c = clock()
  const sampler = new SpeedSampler({ now: c.now })
  const stream = sampler.begin({ provider: 'p', model: 'm' })
  c.set(1000)
  stream.push({ type: 'text-delta', text: 'a'.repeat(10) })
  c.set(20_000)
  stream.push({ type: 'text-delta', text: 'b'.repeat(10) })
  const frame = sampler.frame(c.now())
  // 20s 前的事件已出窗：5s 窗口里只剩 t=20000 那 10 个字符 → 10/3.2/5 ≈ 0.6
  assert.equal(frame.w5, 0.6)
  assert.equal(sampler.events.length, 1)
})
