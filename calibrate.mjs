#!/usr/bin/env node
/**
 * calibrate.mjs — speed-gauge token 统计校准草稿（只读，不修改插件）
 *
 * 它读取 speed-gauge-attempts.jsonl（以及轮转的 .1），用插件自己记录的
 * `chars` + 官方 `outputTokens` 复算 chars/token，回答三个问题：
 *   1. 当前 attempts 日志的 pooled ratio 是多少？
 *   2. 最近 N 个字符（默认 662320，即用户快照的窗口）的真实 ratio 是多少？
 *   3. 如果面板用固定 ratio（默认 2.84），tokensEst 误差多大？
 *
 * 用法：
 *   node calibrate.mjs
 *   node calibrate.mjs --snapshot 662320 233580
 *   node calibrate.mjs --window 300000 --model deepseek-flash
 *   node calibrate.mjs --json C:\dev\dsh-lab\token-audit\calibration.json
 *
 * 注意：这是分析脚本。要真正修插件，请按 token-calibration.md 里的补丁改
 * sampler.js；本脚本不会写 speed-gauge 目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOG = path.join(HERE, 'speed-gauge-attempts.jsonl')
const DEFAULT_ROTATED = DEFAULT_LOG + '.1'

function parseArgs(argv) {
  const out = { logs: [], window: 662320, fixedRatio: 2.84, snapshot: null, model: null, json: null, before: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--log') out.logs.push(argv[++i])
    else if (arg === '--rotated') out.logs.push(argv[++i])
    else if (arg === '--window') out.window = Number(argv[++i])
    else if (arg === '--ratio') out.fixedRatio = Number(argv[++i])
    else if (arg === '--model') out.model = argv[++i]
    else if (arg === '--json') out.json = argv[++i]
    else if (arg === '--before') {
      const raw = argv[++i]
      out.before = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
    } else if (arg === '--snapshot') {
      const chars = Number(argv[++i])
      const tokensEst = Number(argv[++i])
      out.snapshot = { chars, tokensEst }
    } else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    }
  }
  if (out.logs.length === 0) out.logs = [DEFAULT_ROTATED, DEFAULT_LOG]
  out.logs = out.logs.filter((file) => fs.existsSync(file))
  return out
}

function loadRows(files) {
  const rows = []
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (Number.isFinite(row.chars) && Number.isFinite(row.tokens) && row.tokens > 0) rows.push(row)
      } catch {}
    }
  }
  rows.sort((a, b) => a.at - b.at)
  const seen = new Set()
  return rows.filter((row) => {
    const key = [row.at, row.sessionId, row.tokens, row.chars].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 与 sampler.js 的 RatioStore.observe 一致：样本要够大。 */
function isAccepted(row) {
  return row.chars >= 120 && row.tokens >= 20 && row.chars / row.tokens >= 0.15 && row.chars / row.tokens <= 30
}

function quantile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
}

function recentWindow(rows, targetChars) {
  let chars = 0, tokens = 0, used = 0
  for (let i = rows.length - 1; i >= 0 && chars < targetChars; i -= 1) {
    chars += rows[i].chars
    tokens += rows[i].tokens
    used += 1
  }
  return { used, chars, tokens, ratio: chars / tokens }
}

/** 复算当前 RatioStore 的 EWMA（近似；实际实例可能早于日志轮转）。 */
function replayEwma(rows, model) {
  const ratios = new Map()
  const samples = new Map()
  for (const row of rows) {
    if (!isAccepted(row)) continue
    if (model && row.model !== model) continue
    const key = `${row.provider || '?'}/${row.model || '?'}`
    const sample = row.chars / row.tokens
    const prev = ratios.get(key)
    ratios.set(key, prev === undefined ? sample : prev * 0.7 + sample * 0.3)
    samples.set(key, (samples.get(key) || 0) + 1)
  }
  if (ratios.size === 0) return { calibrated: 0, mean: 3.2, samples: 0 }
  let total = 0, count = 0
  for (const value of ratios.values()) { total += value; count += 1 }
  return { calibrated: ratios.size, mean: total / count, samples: [...samples.values()].reduce((a, b) => a + b, 0) }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.logs.length === 0) {
    console.error('找不到 attempts 日志，请用 --log 指定')
    process.exit(2)
  }
  let rows = loadRows(args.logs)
  if (args.before) rows = rows.filter((row) => row.at <= args.before)
  if (args.model) rows = rows.filter((row) => row.model === args.model)
  const accepted = rows.filter(isAccepted)
  const pooled = accepted.reduce((acc, row) => {
    acc.chars += row.chars; acc.tokens += row.tokens
    return acc
  }, { chars: 0, tokens: 0 })
  const samples = accepted.map((row) => row.chars / row.tokens)
  const ewma = replayEwma(rows, args.model)
  const window = recentWindow(rows, args.window)
  const fixed = args.fixedRatio
  const fixedTokens = window.chars / fixed
  const result = {
    logFiles: args.logs,
    attempts: rows.length,
    acceptedSamples: accepted.length,
    pooled: {
      chars: pooled.chars,
      tokens: pooled.tokens,
      ratio: pooled.chars / pooled.tokens,
    },
    sampleDistribution: {
      median: quantile(samples, 0.5),
      p10: quantile(samples, 0.1),
      p90: quantile(samples, 0.9),
      min: samples.length ? Math.min(...samples) : null,
      max: samples.length ? Math.max(...samples) : null,
    },
    replayedEwma: ewma,
    window: {
      targetChars: args.window,
      ...window,
      fixedRatio: fixed,
      tokensAtFixedRatio: Math.round(fixedTokens),
      errorAtFixedRatioPct: ((fixedTokens - window.tokens) / window.tokens) * 100,
    },
    snapshot: args.snapshot ? (() => {
      const trueTokens = window.chars > 0 ? window.tokens * (args.snapshot.chars / window.chars) : null
      const trueRatio = trueTokens ? args.snapshot.chars / trueTokens : null
      return {
        ...args.snapshot,
        trueTokens: Math.round(trueTokens),
        trueRatio,
        errorPct: ((args.snapshot.tokensEst - trueTokens) / trueTokens) * 100,
      }
    })() : null,
    recommendation: {
      note: '不要把单一 ratio 当成全局常数；中文约 1.4，英文/代码约 3.8，混合窗口约 2.55–3.0。',
      pooledRatio: pooled.chars / pooled.tokens,
      recentWindowRatio: window.ratio,
      shouldUseExactUsage: true,
    },
  }
  console.log(JSON.stringify(result, null, 2))
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true })
    fs.writeFileSync(args.json, JSON.stringify(result, null, 2))
    console.log('wrote', args.json)
  }
}

main()
