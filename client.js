/**
 * 生成速度仪表盘 · 客户端
 *
 * 标题栏加一个按钮，面板锚在会话内容列顶部，宽度跟随内容列。
 * 面板整体由 Worker 用 OffscreenCanvas 绘制，主线程只负责发数据。
 *
 * 数据链：host 的 llm/stream → 采样器 → SSE → 组件缓存 → Worker。
 * 口径：
 *  - 实时值是估算：字符率 ÷ 每 token 字符数，ratio 由 host 用 usage 标定；
 *  - 平均/峰值都按最近 30 秒窗口算，总输出用官方 usage 累计；
 *  - 表盘固定 0–500，曲线量程自适应（最低 500，峰值滑出后回落）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-speed-gauge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    // 顶部条要 portal 到会话 header 下面；客户端模块表里有 react-dom。
    var ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (e) { ReactDOM = null }

    var NAME = 'dsh-speed-gauge'
    // 表盘：半圆（180°），0 在左、500 在右。
    var MAX_SPEED = 500
    var START_ANGLE = 180
    var SWEEP = 180
    var GAUGE = { w: 168, h: 96, cx: 84, cy: 88, r: 72 }
    // 迷你曲线：60 秒窗口；量程下限固定 500，峰值超档才往上走。
    var SPARK_MIN_TOP = 500
    var SPARK_SPAN = 30_000
    var RING_FRAMES = 900
    var RING_SPACING = 50
    var RING_KEEP_MS = 35_000
    var SPARK_HOLD_MS = 1200

    // ---------- 文案 ----------
    var TEXT = {
      zh: {
        title: '生成速度',
        unit: 'tok/s',
        estimate: '估算 · 窗口 0.35s',
        idle: '空闲',
        streaming: '生成中',
        w10: '平均',
        peak: '峰值',
        tokens: '总输出',
        reset: '归零',
        connecting: '连接中',
        aria: '生成速度约 {v} 每秒',
        calib: '标定 {n} 次 · {ratio} 字符/token',
        noTitle: '未命名会话',
        err: '仪表盘渲染失败'
      },
      en: {
        title: 'Generation speed',
        unit: 'tok/s',
        estimate: 'estimate · 0.35s window',
        idle: 'idle',
        streaming: 'streaming',
        w10: '10s',
        peak: 'peak',
        tokens: 'total',
        reset: 'reset',
        connecting: 'connecting',
        aria: 'generation speed about {v} per second',
        calib: 'calibrated {n}× · {ratio} chars/token',
        noTitle: 'untitled session',
        err: 'gauge failed to render'
      }
    }

    var pickedLang = null
    var pickedText = TEXT.en

    function pickText() {
      var lang = ''
      try { lang = String(document.documentElement.lang || '') } catch (e) {}
      if (!lang) {
        try { lang = String((navigator && (navigator.language || (navigator.languages && navigator.languages[0]))) || '') } catch (e) {}
      }
      if (lang !== pickedLang) {
        pickedLang = lang
        pickedText = !lang || /^zh/i.test(lang) ? TEXT.zh : TEXT.en
      }
      return pickedText
    }

    function fmt(pattern, vars) {
      return String(pattern).replace(/\{(\w+)\}/g, function (_, key) {
        return vars[key] === undefined || vars[key] === null ? '' : String(vars[key])
      })
    }

    // ---------- 共享数据（组件外，rAF 读取，不触发 React） ----------
    var store = {
      latest: null,
      lastAt: 0,
      rx: 0,
      charsLog: [],      // [{t, chars}] 最近 32 秒，用来算 30 秒平均
      ring: [],          // [{t, v}] 最近 60 秒曲线
      ringAt: 0,
      sparkScale: SPARK_MIN_TOP,
      sparkScaleAt: 0,
      status: 'connecting',
      themeMode: (function () {
        try {
          var v = localStorage.getItem('dsg.theme')
          return v === 'light' || v === 'dark' ? v : 'auto'
        } catch (e) { return 'auto' }
      })(),
      listeners: new Set()
    }

    function notify() {
      store.listeners.forEach(function (fn) { try { fn() } catch (e) {} })
    }

    function acceptFrame(frame) {
      if (!frame || typeof frame !== 'object') return
      // 严格跟当前窗口：别的会话的帧直接丢弃。
      // 当前窗口没在输出时不会有它的帧，面板就按"0"显示（下面按超时归零）。
      if (chartState.sessionId && frame.session && frame.session !== chartState.sessionId) return
      store.latest = frame
      store.lastAt = Date.now()
      store.rx += 1
      var now = store.lastAt
      var chars = Number(frame.chars)
      if (Number.isFinite(chars)) {
        var prevChars = store.charsLog.length ? store.charsLog[store.charsLog.length - 1].chars : null
        // host 重置（归零）或换源时计数器会跳变：清空窗口重建基线。
        if (prevChars !== null && (chars < prevChars || chars - prevChars > 5000)) store.charsLog.length = 0
        store.charsLog.push({ t: now, chars: chars })
        while (store.charsLog.length > 2 && now - store.charsLog[0].t > 11_000) store.charsLog.shift()
      }
      if (now - store.ringAt >= RING_SPACING) {
        store.ringAt = now
        store.ring.push({ t: now, v: Math.max(0, Number(frame.inst) || 0) })
        // 只保留最近 35 秒（面板只看 30 秒），别让缓冲无限长
        while (store.ring.length && now - store.ring[0].t > RING_KEEP_MS) store.ring.shift()
        while (store.ring.length > RING_FRAMES) store.ring.shift()
        // 单调递增的写入序号：缓冲被 shift 修剪时长度不变，下标游标会失效，用序号才可靠
        store.ringSeq = (store.ringSeq || 0) + 1
      }
      if (store.status !== 'live') {
        store.status = 'live'
        notify()
      }
    }

    /**
     * 严格按曲线算平均：对最近 seconds 秒的曲线做梯形积分，
     * 再除以其中"曲线值大于 0"的时长 —— 面积除以非零时间。
     */
    function curveAverage(seconds) {
      var ring = store.ring
      if (!ring || ring.length < 2) return 0
      var last = ring[ring.length - 1]
      var cutoff = last.t - seconds * 1000
      var area = 0
      var active = 0
      var prev = null
      for (var i = 0; i < ring.length; i += 1) {
        var p = ring[i]
        if (p.t < cutoff) { prev = p; continue }
        if (!prev) { prev = p; continue }
        var dt = (p.t - prev.t) / 1000
        if (dt > 0 && (prev.v > 0 || p.v > 0)) {
          area += ((prev.v + p.v) / 2) * dt
          active += dt
        }
        prev = p
      }
      if (!(active > 0.3)) return 0
      return area / active
    }

    /**
     * 最近 seconds 秒的平均速度：只统计"确实在出 token"的那段时间。
     * 空闲、停顿不计入分母，所以生成停了平均不会往下掉。
     */
    function windowRate(seconds) {
      var log = store.charsLog
      if (log.length < 2) return 0
      var last = log[log.length - 1]
      var cutoff = last.t - seconds * 1000
      var start = 0
      for (var i = 0; i < log.length; i += 1) {
        if (log[i].t >= cutoff) { start = i; break }
      }
      if (start > 0) start -= 1 // 往前多取一个点当基准，避免丢边界上的增量
      var delta = 0
      var activeMs = 0
      for (var k = start + 1; k < log.length; k += 1) {
        var d = log[k].chars - log[k - 1].chars
        if (!(d > 0)) continue
        delta += d
        // 相邻两点间隔过长说明中间是空闲，只按一次刷新的时长计入，避免把停顿算成生成时间
        var gap = log[k].t - log[k - 1].t
        activeMs += gap > 1000 ? 200 : gap
      }
      if (activeMs < 300) return 0
      var ratio = Number(store.latest && store.latest.ratio)
      if (!(ratio > 0.2)) ratio = 3.2
      return delta / ratio / (activeMs / 1000)
    }

    function clearLocal() {
      store.ring.length = 0
      store.charsLog.length = 0
      store.ringAt = 0
      store.sparkScale = SPARK_MIN_TOP
      store.sparkScaleAt = 0
    }

    // 每个会话一份曲线缓冲：切走时存起来，切回来原样恢复，互不干扰
    var ringsBySession = new Map()

    /** 切换到某个会话的缓冲；第一次见到该会话则建一个空缓冲。 */
    function useSessionRing(nextId) {
      var prevId = chartState.ringSessionId
      if (prevId && store.ring) ringsBySession.set(prevId, store.ring)
      var next = nextId ? ringsBySession.get(nextId) : null
      if (!next) next = []
      store.ring = next
      chartState.ringSessionId = nextId || null
      store.charsLog = nextId && ringsBySession.has(nextId + ':chars') ? ringsBySession.get(nextId + ':chars') : []
      store.ringAt = 0
      chartState.cursor = 0
      store.ringSeq = 0
      if (chartState.worker) {
        try { chartState.worker.postMessage({ type: 'reset' }) } catch (e) {}
      }
    }

    // ---------- 传输：SSE 优先，失败退化为轮询 ----------
    var transport = { abort: null, retry: 0, timer: null, polling: null, started: false }

    /** 当前正在看的会话 id：DSH 把它放在 data-conversation-session 上。 */
    function currentSessionId() {
      try {
        var el = document.querySelector('[data-conversation-session]')
        if (el) {
          var v = el.getAttribute('data-conversation-session')
          if (v && v.length > 0) return v
        }
        var tagged = document.querySelector('[data-session-id]')
        if (tagged) {
          var w = tagged.getAttribute('data-session-id')
          if (w) return w
        }
      } catch (e) {}
      return null
    }

    // 严格按窗口：拼上会话 id，服务端只回这个会话的帧（空闲时也回 0 帧）
    function transportUrl(path) {
      var sid = chartState.sessionId
      if (!sid) return path
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(sid)
    }

    function stopTransport() {
      transport.started = false
      if (transport.abort) { try { transport.abort.abort() } catch (e) {} ; transport.abort = null }
      if (transport.timer !== null) { try { clearTimeout(transport.timer) } catch (e) {} ; transport.timer = null }
      if (transport.polling !== null) { try { clearInterval(transport.polling) } catch (e) {} ; transport.polling = null }
    }

    function scheduleReconnect() {
      if (!transport.started) return
      var delay = Math.min(5000, 500 * Math.pow(1.6, transport.retry++))
      if (transport.timer !== null) { try { clearTimeout(transport.timer) } catch (e) {} }
      transport.timer = setTimeout(function () {
        transport.timer = null
        connect()
      }, delay)
    }

    function connect() {
      if (!transport.started) return
      if (typeof fetch !== 'function') { store.status = 'offline'; notify(); return }
      // 知道当前会话时走轮询：切换窗口只换 URL，不用断线重连，数据不会断档
      if (chartState.sessionId) { startPolling(); return }
      var controller = null
      try { controller = new AbortController() } catch (e) { controller = null }
      transport.abort = controller
      fetch(transportUrl('api/dsh-speed-gauge/stream'), { cache: 'no-store', headers: { accept: 'text/event-stream' }, signal: controller ? controller.signal : undefined })
        .then(function (response) {
          if (!response.ok) throw new Error('status ' + response.status)
          if (!response.body || typeof response.body.getReader !== 'function') {
            startPolling()
            return null
          }
          transport.retry = 0
          var reader = response.body.getReader()
          var decoder = new TextDecoder()
          var buffer = ''
          function handleBlock(block) {
            var dataLines = []
            var lines = block.split('\n')
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i]
              if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim())
            }
            if (dataLines.length === 0) return
            try { acceptFrame(JSON.parse(dataLines.join('\n'))) } catch (e) {}
          }
          function pump() {
            return reader.read().then(function (step) {
              if (step.done) return null
              try { buffer += decoder.decode(step.value, { stream: true }) } catch (e) {}
              var index
              while ((index = buffer.indexOf('\n\n')) >= 0) {
                var block = buffer.slice(0, index)
                buffer = buffer.slice(index + 2)
                handleBlock(block)
              }
              return pump()
            })
          }
          return pump()
        })
        .then(function () {
          if (!transport.started) return
          if (transport.polling !== null) return
          store.status = 'connecting'
          notify()
          scheduleReconnect()
        })
        .catch(function () {
          if (!transport.started) return
          if (transport.polling !== null) return
          store.status = 'connecting'
          notify()
          scheduleReconnect()
        })
    }

    function startPolling() {
      if (transport.polling !== null) return
      store.status = 'polling'
      notify()
      var busy = false
      transport.polling = setInterval(function () {
        if (busy || !transport.started) return
        busy = true
        fetch(transportUrl('api/dsh-speed-gauge/snapshot'), { cache: 'no-store' })
          .then(function (res) { return res.json() })
          .then(function (frame) { acceptFrame(frame) })
          .catch(function () {})
          .then(function () { busy = false })
      }, 50)
    }

    function startTransport() {
      if (transport.started) return
      // 先确定"当前窗口的会话"，再建订阅：顺序反了就会拿到别的会话的数据
      if (chartState.sessionId === undefined) chartState.sessionId = currentSessionId()
      transport.started = true
      transport.retry = 0
      connect()
    }

    // ---------- 几何 ----------
    function clamp(value, low, high) {
      return value < low ? low : value > high ? high : value
    }

    function polar(cx, cy, r, deg) {
      var rad = (deg * Math.PI) / 180
      return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
    }

    function arcPath(cx, cy, r) {
      var from = polar(cx, cy, r, START_ANGLE)
      var to = polar(cx, cy, r, START_ANGLE + SWEEP)
      var large = SWEEP > 180 ? 1 : 0
      return 'M ' + from.x.toFixed(2) + ' ' + from.y.toFixed(2) +
        ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + to.x.toFixed(2) + ' ' + to.y.toFixed(2)
    }

    function ratioToAngle(ratio) {
      return START_ANGLE + clamp(ratio, 0, 1) * SWEEP
    }

    // ---------- 主题 ----------
    function luminance(red, green, blue) {
      return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
    }

    function detectTheme() {
      try {
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
      } catch (e) {}
      var scheme = ''
      try { scheme = String(window.getComputedStyle(document.documentElement).getPropertyValue('color-scheme') || '') } catch (e) {}
      if (/dark/i.test(scheme) && !/light/i.test(scheme)) return 'dark'
      if (/light/i.test(scheme) && !/dark/i.test(scheme)) return 'light'
      var nodes = []
      try { if (document.body) nodes.push(document.body) } catch (e) {}
      for (var i = 0; i < nodes.length; i += 1) {
        try {
          var bg = String(window.getComputedStyle(nodes[i]).backgroundColor || '')
          var match = bg.match(/rgba?\(([^)]+)\)/)
          if (!match) continue
          var parts = match[1].split(',').map(Number)
          var alpha = parts.length > 3 ? parts[3] : 1
          if (!(alpha > 0.4) || !isFinite(parts[0])) continue
          return luminance(parts[0], parts[1], parts[2]) < 0.45 ? 'dark' : 'light'
        } catch (e) {}
      }
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
      } catch (e) {}
      return 'light'
    }

    // ---------- 样式 ----------
    var CSS = [
      /* 顶部面板：插在会话内容列最前面（插件自己放锚点），宽度取输入框宽度的 60%。 */
      '.dsg-anchor{flex:none;width:100%;}',
      '.dsg-bar{box-sizing:border-box;display:flex;justify-content:center;padding:8px 0 2px;overflow:visible;}',
      /* 跟随会话内容列：宽度 = 列宽的 3/4，列被压窄时面板同步缩短 */
      '.dsg-dock{box-sizing:border-box;position:relative;width:75%;max-width:100%;',
      'margin:0 auto;border-radius:var(--dsw-radius-lg,14px);',
      'border:.5px solid var(--dsw-alias-border-l1,rgba(140,165,255,.22));',
      'background:var(--dsw-specific-menu,rgba(30,34,43,.94));box-shadow:var(--dsw-elevation-panel,0 10px 28px rgba(0,0,0,.28));',
      'backdrop-filter:blur(10px);',
      'overflow:hidden;}',
      '.dsg-panel{display:block;width:100%;height:96px;}',
      /* 透明热区：盖在 Worker 画的"归零"胶囊上（右侧 14px，56x22） */
      '.dsg-reset-hit{position:absolute;right:14px;top:50%;transform:translateY(-50%);width:56px;height:22px;',
      'padding:0;border:0;border-radius:11px;background:transparent;cursor:pointer;opacity:0;pointer-events:auto;}',
      '.dsg-reset-hit:focus-visible{opacity:.18;background:var(--dsw-alias-label-primary,#e9eef7);}',
      '.dsg-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
      'color:var(--dsw-alias-label-secondary,#9aa3b2);background:var(--dsw-specific-menu,rgba(30,34,43,.94));',
      'font-variant-numeric:tabular-nums;letter-spacing:.01em;}',
      /* 会话区顶部的开关：仿 DSH 头部胶囊（图标 + 文字），面板收起后仍在 */
      '.dsg-bar{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;}',
      '.dsg-toggle{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px;border-radius:13px;',
      'border:.5px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1b1f27) 72%,transparent);',
      'color:var(--dsw-alias-label-secondary,#9aa3b2);',
      'font:500 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;cursor:pointer;',
      'backdrop-filter:blur(8px);transition:background .15s,color .15s,border-color .15s;}',
      '.dsg-toggle:hover{color:var(--dsw-alias-label-primary,#e9eef7);border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.5));}',
      '.dsg-toggle[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#e9eef7);',
      'border-color:rgba(96,150,255,.55);background:rgba(96,150,255,.14);}',
      '.dsg-toggle-icon{display:block;opacity:.9;}',
      /* 标题栏里的开关胶囊（由脚本插进 header，和"标准模式""智能体团队"同排） */
      /* 标题栏里的开关胶囊：只用排布，颜色/字体/边框在插入时从相邻按钮的 computedStyle 复制 */
      '.dsg-pill{display:inline-flex;align-items:center;gap:6px;cursor:pointer;background:transparent;border:0;',
      'padding:0 10px;border-radius:13px;transition:background .15s,color .15s;}',
      '.dsg-pill svg{display:block;}',
      '.dsg-probe{position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:60vw;padding:4px 8px;',
      'border-radius:6px;background:rgba(0,0,0,.78);color:#7fe0a0;font:11px/1.5 ui-monospace,Consolas,monospace;',
      'white-space:pre-wrap;word-break:break-all;pointer-events:none;}'
    ].join('')

    function ensureStyle() {
      try {
        var el = document.getElementById('dsg-style')
        if (!el) {
          el = document.createElement('style')
          el.id = 'dsg-style'
          document.head.appendChild(el)
        }
        if (el.textContent !== CSS) el.textContent = CSS
      } catch (e) {}
    }

    // ---------- 读数辅助 ----------
    function readSpeed(frame) {
      if (!frame) return 0
      var value = Number(frame.inst)
      return Number.isFinite(value) ? Math.max(0, value) : 0
    }

    function shortNumber(value) {
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(Math.round(value))
    }

    function sessionRows(frame) {
      var rows = frame && frame.streams ? frame.streams : []
      var out = []
      for (var i = 0; i < rows.length && i < 3; i++) {
        var row = rows[i] || {}
        out.push({
          title: String(row.title || ''),
          model: String(row.model || ''),
          inst: Math.max(0, Number(row.inst) || 0),
          aux: !!row.aux
        })
      }
      return out
    }

    function sameRows(a, b) {
      if (a.length !== b.length) return false
      for (var i = 0; i < a.length; i++) {
        if (a[i].title !== b[i].title || a[i].model !== b[i].model || a[i].aux !== b[i].aux) return false
      }
      return true
    }

    // ---------- 迷你曲线（canvas，独立于 React） ----------
    /** 折线图自适应量程：下限 500，峰值超档即时升档，峰值滑出窗口后回落。 */
    function niceTop(maxValue) {
      if (!(maxValue > SPARK_MIN_TOP)) return SPARK_MIN_TOP
      if (maxValue <= 1000) return Math.ceil(maxValue / 100) * 100
      if (maxValue <= 5000) return Math.ceil(maxValue / 500) * 500
      return Math.ceil(maxValue / 1000) * 1000
    }

    function currentSparkScale(dataMax, now) {
      var desired = niceTop(dataMax * 1.15)
      if (desired > store.sparkScale) {
        store.sparkScale = desired
        store.sparkScaleAt = now
      } else if (desired < store.sparkScale && now - store.sparkScaleAt > SPARK_HOLD_MS) {
        store.sparkScale = desired
        store.sparkScaleAt = now
      }
      return store.sparkScale
    }

    /**
     * 画布颜色：CSS 变量管不到 canvas，所以直接量卡片自己的底色/文字色。
     * 皮肤插件可能把 body 标成深色而内容区是浅色，按“我们实际画在什么底色上”取色最可靠。
     */
    function canvasPalette(hostEl, force) {
      try {
        var style = window.getComputedStyle(hostEl)
        var text = String(style.color || '')
        var match = text.match(/rgba?\(([^)]+)\)/)
        var r = 200
        var g = 204
        var b = 212
        if (match) {
          var parts = match[1].split(',').map(Number)
          if (isFinite(parts[0])) { r = parts[0]; g = parts[1]; b = parts[2] }
        }
        var bg = String(style.backgroundColor || '')
        var bgMatch = bg.match(/rgba?\(([^)]+)\)/)
        var alpha = 1
        var lum = 0.3
        if (bgMatch) {
          var bp = bgMatch[1].split(',').map(Number)
          alpha = bp.length > 3 ? bp[3] : 1
          if (isFinite(bp[0])) lum = (0.2126 * bp[0] + 0.7152 * bp[1] + 0.0722 * bp[2]) / 255
        }
        // 跟随宿主明暗（先用回可读的一版，反转方案还需再调）
        var dark = alpha < 0.4 ? store.theme !== 'light' : lum < 0.5
        var ink = r + ',' + g + ',' + b
        return {
          dark: dark,
          key: (dark ? 'd' : 'l') + ink,
          grid: 'rgba(' + ink + ',.16)',
          axis: 'rgba(' + ink + ',.62)',
          line: dark ? 'rgba(120,175,255,.95)' : 'rgba(42,108,215,.95)',
          areaTop: dark ? 'rgba(76,141,255,.36)' : 'rgba(60,120,220,.24)',
          areaBottom: dark ? 'rgba(76,141,255,0)' : 'rgba(60,120,220,0)',
          peak: dark ? '#ffd479' : '#b57a00',
          peakText: dark ? 'rgba(255,212,121,.95)' : 'rgba(166,108,0,.95)',
          dot: dark ? '#9cc2ff' : '#2f6fd0',
          value: dark ? 'rgba(' + ink + ',.9)' : 'rgba(' + ink + ',.95)',
          // 彗星头 + 尾巴渐变（三段：头部亮、中段半透、尾部全透）
          head: dark ? '#eaf3ff' : '#124fa8',
          tailNear: dark ? 'rgba(175,215,255,.62)' : 'rgba(44,110,215,.32)',
          tailMid: dark ? 'rgba(120,175,255,.20)' : 'rgba(60,130,225,.11)',
          tailFar: dark ? 'rgba(120,175,255,0)' : 'rgba(60,130,225,0)',
          // 表盘
          gaugeTrack: dark ? 'rgba(140,160,200,.20)' : 'rgba(120,140,170,.22)',
          gaugeFrom: dark ? '#6ec8ff' : '#6ec8ff',
          gaugeTo: dark ? '#7b3ff2' : '#7b3ff2',
          needle: dark ? 'rgba(234,240,250,.95)' : 'rgba(26,42,66,.92)',
          halo: bgMatch ? (alpha >= 0.9 ? 'rgb(' + bp[0] + ',' + bp[1] + ',' + bp[2] + ')' : 'rgba(' + ink + ',.85)') : 'rgba(' + ink + ',.85)'
        }
      } catch (e) {
        return null
      }
    }

    // ---------- 曲线几何：只算 (ageMs, value)，像素坐标全部交给 Worker ----------
    var sparkPts = []
    // width 由 ResizeObserver 写入；mode: pending / loading / worker / fallback
    var chartState = {
      width: 0,
      mode: 'pending',
      worker: null,
      canvasEl: null,
      lastState: 0,
      lastPoints: 0,
      error: ''
    }

    /**
     * 60 秒窗口内的点：返回 (ageMs, 平滑后的值)，不涉及像素。
     * 量程升/降仍在主线程（它依赖 store 的保持计时），Worker 只做映射。
     */
    function computePoints(ring, nowMs) {
      var count = ring.length
      var dataMax = 0
      var peakSample = null
      // 量程只统计"还在 60 秒窗口内"的样本（留 0.5s 边界余量）：
      // 峰值一旦滑出窗口（最左边看不见了），dataMax 自然回落，天花板就会降回来。
      var windowMaxAge = SPARK_SPAN - 500
      for (var i = 0; i < count; i += 1) {
        var sampleAge = nowMs - ring[i].t
        if (sampleAge < 0 || sampleAge > windowMaxAge) continue
        if (ring[i].v > dataMax) { dataMax = ring[i].v; peakSample = ring[i] }
      }
      if (!peakSample) {
        for (var k = 0; k < count; k += 1) {
          if (ring[k].v > dataMax) { dataMax = ring[k].v; peakSample = ring[k] }
        }
      }
      // 天花板连续自适应（不分档）：目标 = max(500, 窗口峰值 × 1.15)，
      // 每帧向目标缓动，峰值滑出窗口后 dataMax 回落，天花板跟着平滑降下来。
      var desiredTop = Math.max(SPARK_MIN_TOP, dataMax * 1.15)
      if (!(store.sparkScale > 0)) store.sparkScale = desiredTop
      store.sparkScale += (desiredTop - store.sparkScale) * 0.08
      if (Math.abs(desiredTop - store.sparkScale) < 0.5) store.sparkScale = desiredTop
      var top = store.sparkScale
      var pts = sparkPts
      pts.length = 0
      var prevValue = count > 0 ? ring[0].v : 0
      for (var j = 0; j < count; j += 1) {
        // 存绝对时间戳（Date.now），Worker 也用同一个墙钟算 x —— 这样每帧的映射是单调的，
        // 不会因为"主线程 → Worker 的传输延迟 / 重锚点"让曲线左右抖。
        if (nowMs - ring[j].t > SPARK_SPAN + 200) { prevValue = ring[j].v; continue }
        var current = ring[j].v
        var next = j + 1 < count ? ring[j + 1].v : current
        var smoothed = (prevValue + current * 2 + next) / 4
        pts.push(nowMs - ring[j].t, smoothed)
        prevValue = current
      }
      return {
        top: top,
        pts: pts,
        count: count,
        ringLast: count > 0 ? ring[count - 1].v : 0,
        chartPeakV: peakSample ? peakSample.v : 0,
        chartPeakAge: peakSample ? nowMs - peakSample.t : 0
      }
    }

    // ---------- 面板 Worker：整块面板（表盘 + 数字 + 曲线）都在 Worker 里画 ----------
    var WORKER_URL = 'api/dsh-speed-gauge/panel-worker.js'

    function initPanelWorker(canvas, onFallback) {
      if (chartState.mode === 'loading' || chartState.mode === 'worker') return
      if (!canvas || typeof Worker !== 'function' || typeof canvas.transferControlToOffscreen !== 'function') {
        chartState.mode = 'fallback'
        if (onFallback) onFallback()
        return
      }
      chartState.mode = 'loading'
      // 页面可能是 dsh-app:// 自定义 scheme：先按相对路径取源码，再用 Blob 起 Worker
      fetch(WORKER_URL, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status)
          return res.text()
        })
        .then(function (code) {
          if (chartState.mode !== 'loading') return
          var blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
          var worker = null
          try {
            worker = new Worker(blobUrl)
          } catch (e) {
            chartState.error = 'worker:' + ((e && e.message) || e)
            chartState.mode = 'fallback'
            if (onFallback) onFallback()
            return
          } finally {
            setTimeout(function () { URL.revokeObjectURL(blobUrl) }, 1000)
          }
          var settled = false
          var timer = setTimeout(function () {
            if (settled) return
            settled = true
            try { worker.terminate() } catch (e) {}
            chartState.worker = null
            chartState.mode = 'fallback'
            if (onFallback) onFallback()
          }, 2500)
          worker.onmessage = function (event) {
            var msg = event.data || {}
            if (msg.type !== 'ready' || settled) return
            settled = true
            clearTimeout(timer)
            try {
              var offscreen = canvas.transferControlToOffscreen()
              worker.postMessage({
                type: 'init',
                canvas: offscreen,
                width: chartState.width,
                dpr: window.devicePixelRatio || 1
              }, [offscreen])
              chartState.worker = worker
              chartState.canvasEl = canvas
              chartState.mode = 'worker'
            } catch (e) {
              chartState.mode = 'fallback'
              chartState.worker = null
              try { worker.terminate() } catch (err) {}
              if (onFallback) onFallback()
            }
          }
          worker.onerror = function () {
            if (settled) return
            settled = true
            clearTimeout(timer)
            chartState.mode = 'fallback'
            chartState.worker = null
            try { worker.terminate() } catch (e) {}
            if (onFallback) onFallback()
          }
          chartState.worker = worker
          try { worker.postMessage({ type: 'hello' }) } catch (e) {}
        })
        .catch(function (err) {
          chartState.error = 'fetch:' + ((err && err.message) || err)
          chartState.mode = 'fallback'
          if (onFallback) onFallback()
        })
    }

    /** 只统计"面板可见窗口"（最近 SPARK_SPAN 毫秒）内的峰值，而不是全会话峰值。 */
    function windowPeak(nowMs) {
      var peak = 0
      var ring = store.ring
      for (var i = 0; i < ring.length; i += 1) {
        var age = nowMs - ring[i].t
        if (age < 0 || age > SPARK_SPAN) continue
        if (ring[i].v > peak) peak = ring[i].v
      }
      return peak
    }

    function postPanelState(frame, palette) {
      var worker = chartState.worker
      if (!worker) return
      try {
        worker.postMessage({
          type: 'state',
          inst: readSpeed(frame),
          short: frame ? Math.max(0, Number(frame.w1) || 0) : 0,
          peak: windowPeak(Date.now()),
          total: frame ? Number(frame.tokensEst) || 0 : 0,
          w10: curveAverage(10),
          live: !!(frame && store.lastAt && Date.now() - store.lastAt < 2000),
          colors: palette || null
        })
      } catch (e) {}
    }

    function postPanelPoints(ring, nowMs, palette) {
      var worker = chartState.worker
      if (!worker) return
      var chart = computePoints(ring, nowMs)
      var copy = new Float32Array(chart.pts)
      try {
        worker.postMessage({
          type: 'points',
          top: chart.top,
          pts: copy,
          ringLast: chart.ringLast,
          chartPeakV: chart.chartPeakV,
          chartPeakAge: chart.chartPeakAge,
          live: !!(store.lastAt && nowMs - store.lastAt < 2000),
          colors: palette || null
        }, [copy.buffer])
      } catch (e) {}
    }



    // ---------- 独立渲染 Worker（整块面板离屏绘制，主线程卡顿不影响它） ----------
    var workerPromise = null
    function ensurePanelWorker () {
      if (workerPromise) return workerPromise
      workerPromise = fetch('api/dsh-speed-gauge/panel-worker.js', { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('worker http ' + res.status)
          return res.text()
        })
        .then(function (code) {
          var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
          return new Worker(url)
        })
      return workerPromise
    }

    // ---------- 面板绘制（主线程）：x 每帧用 Date.now() 现算，不经过 Worker ----------
    var PANEL_H = 96
    var PANEL_PAD = 14
    var needleShown = 0
    var needleReady = false
    var panelSparks = []
    var panelSparkSprite = null
    var panelHeadSprite = null
    var panelSpriteKey = ''

    function panelShort (value) {
      var n = Number(value) || 0
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
      if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
      return String(Math.round(n))
    }

    function drawPaintError (ctx, where, err) {
      try {
        ctx.fillStyle = '#c00'
        ctx.font = '600 9px system-ui,sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(where + ': ' + ((err && err.message) || err), 8, 2)
      } catch (e) {}
    }

    function panelLayout (width) {
      var gaugeW = Math.min(196, Math.max(150, width * 0.19))
      var statsW = 128
      var resetW = 56
      var gap = 14
      var plotStart = PANEL_PAD + gaugeW + gap + statsW + gap
      var plotW = Math.max(90, width - PANEL_PAD - resetW - 12 - plotStart)
      return {
        gauge: { x: PANEL_PAD, y: 4, w: gaugeW, h: PANEL_H - 8 },
        stats: { x: PANEL_PAD + gaugeW + gap, y: 8, w: statsW, h: PANEL_H - 16 },
        reset: { x: width - PANEL_PAD - resetW, y: PANEL_H / 2 - 11, w: resetW, h: 22 },
        plot: { x: plotStart, y: 14, w: plotW, h: PANEL_H - 28 }
      }
    }

    function panelRoundRect (ctx, x, y, w, h, r) {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }

    /** #rrggbb / rgba(...) → "r,g,b"（精灵贴图需要纯色三元组） */
    function panelRgb (color) {
      var str = String(color || '')
      var rgba = str.match(/rgba?\(([^)]+)\)/)
      if (rgba) {
        var p = rgba[1].split(',').map(Number)
        if (isFinite(p[0])) return Math.round(p[0]) + ',' + Math.round(p[1]) + ',' + Math.round(p[2])
      }
      var hex = str.replace('#', '').trim()
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
      if (hex.length >= 6) {
        var r = parseInt(hex.slice(0, 2), 16)
        var g = parseInt(hex.slice(2, 4), 16)
        var b = parseInt(hex.slice(4, 6), 16)
        if (isFinite(r) && isFinite(g) && isFinite(b)) return r + ',' + g + ',' + b
      }
      return '120,175,255'
    }

    function panelSprite (size, rgb) {
      var s = document.createElement('canvas')
      s.width = size
      s.height = size
      var g = s.getContext('2d')
      if (!g) return null
      var half = size / 2
      var grad = g.createRadialGradient(half, half, 0, half, half, half)
      grad.addColorStop(0, 'rgba(' + rgb + ',0.60)')
      grad.addColorStop(0.3, 'rgba(' + rgb + ',0.24)')
      grad.addColorStop(0.62, 'rgba(' + rgb + ',0.07)')
      grad.addColorStop(1, 'rgba(' + rgb + ',0)')
      g.fillStyle = grad
      g.beginPath()
      g.arc(half, half, half, 0, Math.PI * 2)
      g.fill()
      return s
    }

    function panelEnsureSprites (colors) {
      var key = colors.head + '|' + colors.line
      if (panelSpriteKey === key) return
      panelHeadSprite = panelSprite(48, panelRgb(colors.head))
      panelSparkSprite = panelSprite(16, panelRgb(colors.line))
      panelSpriteKey = key
    }

    function paintPanel (canvas, hostEl, nowMs) {
      if (!canvas) return
      var ctx = canvas.getContext('2d')
      if (!ctx) return
      var width = chartState.width
      if (width <= 40) return
      var dpr = window.devicePixelRatio || 1
      var bw = Math.round(width * dpr)
      var bh = Math.round(PANEL_H * dpr)
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, PANEL_H)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      var raw = store.palette || canvasPalette(hostEl) || {}
      var colors = {
        grid: raw.grid || 'rgba(127,127,127,.18)',
        axis: raw.axis || 'rgba(127,127,127,.62)',
        line: raw.line || 'rgba(42,108,215,.95)',
        areaTop: raw.areaTop || 'rgba(60,120,220,.24)',
        areaBottom: raw.areaBottom || 'rgba(60,120,220,0)',
        dot: raw.dot || '#2f6fd0',
        value: raw.value || 'rgba(30,42,60,.95)',
        head: raw.head || '#124fa8',
        tailNear: raw.tailNear || 'rgba(44,110,215,.32)',
        tailMid: raw.tailMid || 'rgba(60,130,225,.11)',
        tailFar: raw.tailFar || 'rgba(60,130,225,0)',
        gaugeTrack: raw.gaugeTrack || 'rgba(120,140,170,.22)',
        gaugeFrom: raw.gaugeFrom || '#6ec8ff',
        gaugeTo: raw.gaugeTo || '#7b3ff2',
        needle: raw.needle || 'rgba(26,42,66,.92)',
        dark: !!raw.dark
      }
      var frame = store.latest
      var box = panelLayout(width)

      var target = readSpeed(frame) * 0.6 + (frame ? Math.max(0, Number(frame.w1) || 0) : 0) * 0.4
      if (!needleReady) { needleShown = target; needleReady = true }
      needleShown += (target - needleShown) * 0.2
      if (needleShown < 0.15) needleShown = 0

      try { panelDrawCurve(ctx, box.plot, nowMs, colors) } catch (e) { drawPaintError(ctx, 'curve', e) }
      try { panelDrawGauge(ctx, box.gauge, needleShown, frame ? Number(frame.peak) || 0 : 0, colors) } catch (e) { drawPaintError(ctx, 'gauge', e) }
      try { panelDrawStats(ctx, box.stats, frame, colors) } catch (e) { drawPaintError(ctx, 'stats', e) }
      try { panelDrawReset(ctx, box.reset, colors) } catch (e) { drawPaintError(ctx, 'reset', e) }
    }

    function panelDrawGauge (ctx, box, value, peakValue, colors) {
      var cx = box.x + box.w / 2
      var r = Math.min(box.w * 0.48, PANEL_H * 0.56)
      var cy = PANEL_H / 2 + (r - 16) / 2
      var START = Math.PI
      var ratio = Math.max(0, Math.min(1, value / 500))

      ctx.lineCap = 'round'
      ctx.lineWidth = 7
      ctx.strokeStyle = colors.gaugeTrack
      ctx.beginPath()
      ctx.arc(cx, cy, r, START, START + Math.PI)
      ctx.stroke()

      if (ratio > 0.002) {
        var grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0)
        grad.addColorStop(0, colors.gaugeFrom)
        grad.addColorStop(1, colors.gaugeTo)
        ctx.strokeStyle = grad
        ctx.beginPath()
        ctx.arc(cx, cy, r, START, START + Math.PI * ratio)
        ctx.stroke()
      }

      for (var i = 0; i <= 20; i += 1) {
        var a = START + (Math.PI * i) / 20
        var inner = i % 4 === 0 ? r - 12 : r - 7
        ctx.globalAlpha = i % 4 === 0 ? 0.7 : 0.32
        ctx.lineWidth = i % 4 === 0 ? 1.4 : 1
        ctx.strokeStyle = colors.axis
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
        ctx.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3))
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      var angle = START + Math.PI * ratio
      ctx.strokeStyle = colors.needle
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * (r * 0.44), cy + Math.sin(angle) * (r * 0.44))
      ctx.lineTo(cx + Math.cos(angle) * (r - 3), cy + Math.sin(angle) * (r - 3))
      ctx.stroke()

      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = colors.value
      ctx.font = '600 30px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
      ctx.fillText(String(Math.round(value)), cx, cy - 4)
      ctx.fillStyle = colors.axis
      ctx.font = '500 9px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
      ctx.fillText('tok/s', cx, cy + 12)
      ctx.font = '500 8.5px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
      ctx.fillText('0', cx - r, cy + 15)
      ctx.fillText('500', cx + r, cy + 15)
    }

    function panelDrawStats (ctx, box, frame, colors) {
      var rows = [
        { label: '10 秒', value: panelShort(curveAverage(10)) },
        { label: '峰值', value: panelShort(frame ? Number(frame.peak) || 0 : 0) },
        { label: '总输出', value: panelShort(frame ? Number(frame.tokensEst) || 0 : 0) }
      ]
      var rowH = box.h / 3
      for (var i = 0; i < rows.length; i += 1) {
        var baseY = box.y + rowH * i + rowH * 0.5 + 5
        ctx.textBaseline = 'alphabetic'
        ctx.textAlign = 'left'
        ctx.font = '500 9px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
        ctx.fillStyle = colors.axis
        ctx.fillText(rows[i].label, box.x, baseY)
        ctx.font = '600 15px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
        ctx.fillStyle = colors.value
        ctx.fillText(rows[i].value, box.x + 54, baseY)
      }
    }

    function panelDrawReset (ctx, box, colors) {
      panelRoundRect(ctx, box.x, box.y, box.w, box.h, box.h / 2)
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '500 10px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
      ctx.fillStyle = colors.value
      ctx.fillText('归零', box.x + box.w / 2, box.y + box.h / 2 + 0.5)
    }

    function panelDrawCurve (ctx, box, nowMs, colors) {
      var yTop = box.y
      var yBottom = box.y + box.h
      ctx.font = '500 8px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(box.x + 2, yTop)
      ctx.lineTo(box.x + box.w, yTop)
      ctx.moveTo(box.x + 2, yBottom)
      ctx.lineTo(box.x + box.w, yBottom)
      ctx.stroke()

      var chart = computePoints(store.ring, nowMs)
      var top = chart.top > 0 ? chart.top : 500
      var pts = chart.pts
      ctx.fillStyle = colors.axis
      ctx.fillText(panelShort(top), box.x, yTop - 3)
      ctx.fillText(panelShort(top / 2), box.x, (yTop + yBottom) / 2 - 3)

      var n = pts.length / 2
      if (n < 2) return
      var pxPerMs = box.w / 60000
      var xs = []
      var ys = []
      for (var i = 0; i < pts.length; i += 2) {
        var x = box.w - pts[i] * pxPerMs
        if (x < -6) continue
        var y = yBottom - Math.max(0, Math.min(1, pts[i + 1] / top)) * (yBottom - yTop)
        xs.push(x)
        ys.push(y)
      }
      if (xs.length < 2) return

      // 面积
      var grad = ctx.createLinearGradient(0, yTop, 0, yBottom)
      grad.addColorStop(0, colors.areaTop)
      grad.addColorStop(1, colors.areaBottom)
      ctx.beginPath()
      ctx.moveTo(box.x + xs[0], yBottom)
      ctx.lineTo(box.x + xs[0], ys[0])
      for (var a = 1; a < xs.length; a += 1) ctx.lineTo(box.x + xs[a], ys[a])
      ctx.lineTo(box.x + xs[xs.length - 1], yBottom)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()

      // 彗星先画、曲线压在上面：尾巴不会在粗线旁边显出一条细亮线
      panelDrawComet(ctx, box, xs, ys, nowMs, colors)

      // 曲线
      ctx.beginPath()
      ctx.moveTo(box.x + xs[0], ys[0])
      for (var b = 1; b < xs.length; b += 1) ctx.lineTo(box.x + xs[b], ys[b])
      ctx.strokeStyle = colors.line
      ctx.lineWidth = 1.7
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    function panelDrawComet (ctx, box, xs, ys, nowMs, colors) {
      panelEnsureSprites(colors)
      var dt = chartState.sparkAt ? Math.min(120, nowMs - chartState.sparkAt) : 16
      chartState.sparkAt = nowMs
      var headX = box.w
      var headY = ys[ys.length - 1]
      var live = !!(store.lastAt && nowMs - store.lastAt < 2000)

      for (var i = panelSparks.length - 1; i >= 0; i -= 1) {
        var s = panelSparks[i]
        s.age += dt
        s.x -= (box.w / 60000) * dt * s.speed
        // 竖直方向自由发散（上下两侧都散开），不再贴着曲线
        s.y += s.drift * (dt / 1000)
        // 出界（上下越出曲线区 / 左边出去）就消失
        if (s.age >= s.life || s.x < -6 || s.y < box.y - 2 || s.y > box.y + box.h + 2) panelSparks.splice(i, 1)
      }
      // 火花：从头部向左右上下散开
      var emit = live ? (Math.random() < 0.34 ? 2 : 0) : 0
      for (var e = 0; e < emit; e += 1) {
        panelSparks.push({
          x: headX - Math.random() * 14,
          y: headY + (Math.random() - 0.5) * 4,
          age: 0,
          life: 1500 + Math.random() * 1500,
          speed: 1.6 + Math.random() * 1.8,
          size: 0.8 + Math.random() * 1.2,
          // 80% 向上飘、20% 向下：画布 y 向下为正，所以向上是负速度
          drift: Math.random() < 0.8 ? -(6 + Math.random() * 26) : (4 + Math.random() * 14),
          hot: Math.random() < 0.35
        })
      }
      if (panelSparks.length > 64) panelSparks.splice(0, panelSparks.length - 64)

      if (live || panelSparks.length > 0) {
        ctx.globalCompositeOperation = colors.dark ? 'lighter' : 'source-over'
        if (panelHeadSprite) {
          var pulse = 11 + Math.sin(nowMs / 240) * 0.9
          ctx.globalAlpha = colors.dark ? 0.95 : 0.85
          ctx.drawImage(panelHeadSprite, box.x + headX - pulse, headY - pulse, pulse * 2, pulse * 2)
          ctx.globalAlpha = 1
        }
        ctx.beginPath()
        ctx.arc(box.x + headX, headY, 2.4, 0, Math.PI * 2)
        ctx.fillStyle = colors.head
        ctx.fill()

        if (panelSparkSprite) {
          for (var m = 0; m < panelSparks.length; m += 1) {
            var q = panelSparks[m]
            var remain = 1 - q.age / q.life
            var reach = q.size * (0.45 + 0.55 * remain) * 2.8
            // 上下自由发散，限制在曲线区内
            var sy = q.y
            // 深色粒子（hot）用头部色，普通粒子用线条色；横向拉出一点丝
            var spr = q.hot ? (panelHeadSprite || panelSparkSprite) : panelSparkSprite
            var sw = reach * (q.hot ? 2.4 : 2.0)
            var sh = reach * (q.hot ? 1.7 : 1.5)
            ctx.globalAlpha = (q.hot ? 0.24 : 0.13) + (q.hot ? 0.3 : 0.2) * remain
            ctx.drawImage(spr, box.x + q.x - sw / 2, sy - sh / 2, sw, sh)
          }
          ctx.globalAlpha = 1
        }
        ctx.globalCompositeOperation = 'source-over'
      } else {
        ctx.beginPath()
        ctx.arc(box.x + headX, headY, 1.6, 0, Math.PI * 2)
        ctx.fillStyle = colors.dot
        ctx.globalAlpha = 0.55
        ctx.fill()
        ctx.globalAlpha = 1
      }

      ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
      ctx.textAlign = 'right'
      ctx.fillStyle = colors.value
      var vy = headY - 7
      if (vy - 12 < box.y) {
        ctx.textBaseline = 'top'
        ctx.fillText(panelShort(pts_last_value()), box.x + box.w, headY + 8)
      } else {
        ctx.textBaseline = 'bottom'
        ctx.fillText(panelShort(pts_last_value()), box.x + box.w, vy)
      }
      function pts_last_value () { return store.ring.length ? store.ring[store.ring.length - 1].v : 0 }
    }

    var panelApi = { toggle: null }

    // ---------- 面板主体：一个 canvas + 一个透明的"归零"按钮 ----------
    function SpeedGauge() {
      var T = pickText()

      var stateAnchor = React.useState(null)
      var anchorEl = stateAnchor[0]
      var setAnchorEl = stateAnchor[1]

      var stateMode = React.useState(chartState.mode)
      var mode = stateMode[0]
      var setMode = stateMode[1]

      // 面板开关（记忆到 localStorage）
      var stateOn = React.useState(function () {
        try { return localStorage.getItem('dsg.panel.on') !== '0' } catch (e) { return true }
      })
      var enabled = stateOn[0]
      var setEnabled = stateOn[1]
      function togglePanel() {
        var next = !enabled
        setEnabled(next)
        try { localStorage.setItem('dsg.panel.on', next ? '1' : '0') } catch (e) {}
      }
      panelApi.toggle = togglePanel

      // 把开关做进 DSH 顶部标题栏：套用宿主按钮自身的 class，颜色/hover 逻辑完全一致
      React.useEffect(function () {
        var head = document.querySelector('header[data-window-drag]') || document.querySelector('header')
        if (!head) return
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'dsg-pill'
        btn.title = '速度仪表盘'
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
          '<path d="M4 17a8 8 0 0 1 16 0"></path><path d="M12 17l4-6"></path>' +
          '<circle cx="12" cy="17" r="1.3" fill="currentColor" stroke="none"></circle></svg><span>速度仪表盘</span>'
        btn.addEventListener('pointerdown', function (e) { e.stopPropagation() })
        btn.addEventListener('mousedown', function (e) { e.stopPropagation() })
        btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(148,163,184,.16)' })
        btn.addEventListener('mouseleave', function () { btn.style.background = 'transparent' })
        btn.addEventListener('click', function (e) {
          e.preventDefault()
          e.stopPropagation()
          if (panelApi.toggle) panelApi.toggle()
        })
        function place() {
          // 切换会话时宿主会重建 header，所以每次都要重新找，否则按钮会永久消失
          var head2 = document.querySelector('header[data-window-drag]') || document.querySelector('header')
          if (!head2) return
          var target = null
          var refEl = null
          var els = head2.querySelectorAll('span,div,button')
          for (var i = 0; i < els.length; i += 1) {
            var t = (els[i].textContent || '').trim()
            if ((t === '标准模式' || t === '智能体团队') && els[i].children.length === 0) {
              refEl = els[i]
              target = els[i].parentElement
              break
            }
          }
          if (!target) return
          // 直接套用宿主"智能体团队"那个按钮的 class —— 颜色、hover、选中态就都一样了
          if (refEl) {
            var chip = refEl.closest ? refEl.closest('button') : null
            if (!chip) chip = refEl
            var hostCls = (chip.className && typeof chip.className === 'string') ? chip.className : ''
            var want = 'dsg-pill' + (hostCls ? ' ' + hostCls : '')
            if (btn.className !== want) btn.className = want
            var placeParent = chip.parentElement
            if (placeParent && placeParent.tagName && placeParent.tagName.toLowerCase() !== 'button') {
              // 被宿主重建冲掉后要重新挂回去（不只是第一次）
              if (btn.parentElement !== placeParent) placeParent.appendChild(btn)
              return
            }
          }
          if (btn.parentElement !== target) target.appendChild(btn)
        }
        place()
        var timer = setInterval(place, 1200)
        return function () {
          clearInterval(timer)
          try { btn.remove() } catch (e) {}
        }
      }, [])

      React.useEffect(function () {
        var btn = document.querySelector('.dsg-pill')
        if (btn) btn.setAttribute('aria-pressed', enabled ? 'true' : 'false')
      }, [enabled])

      var hostRef = React.useRef(null)
      var canvasRef = React.useRef(null)
      var fallbackRef = React.useRef(null)

      /** 归零：清 host 的峰值/累计，再清本地曲线。 */
      function resetAll() {        try { clearLocal() } catch (e) {}
        try {
          fetch('api/dsh-speed-gauge/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(function () {})
        } catch (e) {}
      }

      /** 浅色 / 深色：默认跟随宿主，点一次就固定成另一套，记住选择。 */
      function toggleTheme() {
        var now = store.themeMode === 'light' ? 'light' : store.themeMode === 'dark' ? 'dark' : (detectTheme() === 'dark' ? 'dark' : 'light')
        var next = now === 'dark' ? 'light' : 'dark'
        store.themeMode = next
        try { localStorage.setItem('dsg.theme', next) } catch (e) {}
        chartState.lastTheme = 0
        try {
          store.palette = canvasPalette(hostRef.current, next)
          if (chartState.worker) chartState.worker.postMessage({ type: 'palette', colors: store.palette })
        } catch (e) {}
      }

      // 锚点：插到会话内容列最前面（宽度跟随输入框）
      React.useEffect(function () {
        var anchor = document.createElement('div')
        anchor.className = 'dsg-anchor'
        function place() {
          try {
            var body = document.querySelector('[data-conversation-content]')
            if (body) {
              if (anchor.style.display) anchor.style.display = ''
              if (anchor.parentElement !== body || body.firstElementChild !== anchor) {
                body.insertBefore(anchor, body.firstElementChild)
              }
              return
            }
            if (anchor.style.display !== 'none') anchor.style.display = 'none'
            if (!anchor.parentElement) {
              var hostHeader = document.querySelector('header[data-window-drag]')
              if (hostHeader && hostHeader.parentElement) hostHeader.parentElement.appendChild(anchor)
            }
          } catch (e) {}
        }
        place()
        setAnchorEl(anchor)
        var timer = setInterval(place, 1000)
        return function () {
          clearInterval(timer)
          try { anchor.remove() } catch (e) {}
        }
      }, [])

      // 宽度跟随（rAF 里只读缓存，不读 DOM）；窗口拉伸时把新宽度同步给 Worker 重设画布
      React.useEffect(function () {
        var wrap = canvasRef.current ? canvasRef.current.parentElement : null
        if (!wrap) return
        function measure() {
          var w = wrap.clientWidth || 0
          if (w <= 40) return
          if (w === chartState.width) return
          chartState.width = w
          var dpr = window.devicePixelRatio || 1
          if (chartState.worker) {
            try { chartState.worker.postMessage({ type: 'layout', width: w, dpr: dpr }) } catch (e) {}
          } else {
            var cv = canvasRef.current
            if (cv) {
              cv.width = Math.round(w * dpr)
              cv.height = Math.round(PANEL_H * dpr)
            }
          }
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          var ro = new ResizeObserver(measure)
          ro.observe(wrap)
          return function () { ro.disconnect() }
        }
        window.addEventListener('resize', measure)
        return function () { window.removeEventListener('resize', measure) }
      }, [anchorEl, mode])

      // 起独立渲染 Worker：整块面板离屏绘制
      React.useEffect(function () {
        if (!anchorEl) return
        var alive = true
        var canvas = canvasRef.current
        if (!canvas || typeof canvas.transferControlToOffscreen !== 'function' || typeof Worker !== 'function') {
          setMode('fallback')
          return
        }
        ensurePanelWorker().then(function (worker) {
          if (!alive) { try { worker.terminate() } catch (e) {} return }
          try {
            var off = canvas.transferControlToOffscreen()
            chartState.worker = worker
            chartState.mode = 'worker'
            worker.postMessage({
              type: 'init',
              canvas: off,
              width: chartState.width || (canvas.parentElement ? canvas.parentElement.clientWidth : 0) || 600,
              dpr: window.devicePixelRatio || 1
            }, [off])
            setMode('worker')
          } catch (e) {
            setMode('fallback')
          }
        }).catch(function () {
          setMode('fallback')
        })
        return function () {
          alive = false
          if (chartState.worker) {
            try { chartState.worker.terminate() } catch (e) {}
            chartState.worker = null
          }
          chartState.mode = 'pending'
        }
      }, [anchorEl])

      // 传输：进入即连，离开即断
      React.useEffect(function () {
        startTransport()
        function onVisibility() {
          if (document.visibilityState === 'visible' && store.status === 'offline') {
            stopTransport()
            startTransport()
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        return function () {
          document.removeEventListener('visibilitychange', onVisibility)
          stopTransport()
        }
      }, [])

      // 主循环：只发数据，不画像素
      React.useEffect(function () {
        var alive = true
        function tick(now) {
          if (!alive) return
          requestAnimationFrame(tick)
          if (document.hidden) return
          try {
            var wall = Date.now()
            // 当前窗口长时间没有自己的帧：按 0 处理，别让旧数字挂在那儿
            if (store.latest && wall - store.lastAt > 1500) {
              store.latest = null
            }
            var frame = store.latest
            // 跟随"当前正在看的会话"：连续两次读到同一个新 id 才切换，切换时清缓冲 + 重连
            if (wall - (chartState.lastSessionCheck || 0) > 700) {
              chartState.lastSessionCheck = wall
              var sid = currentSessionId()
              if (sid && chartState.sessionId === undefined) {
                chartState.sessionId = sid
                useSessionRing(sid)
              } else if (sid && sid !== chartState.sessionId) {
                if (chartState.pendingSession === sid) {
                  chartState.pendingSession = null
                  chartState.sessionId = sid
                  // 切到目标会话自己的曲线缓冲：切回来还是原样
                  useSessionRing(sid)
                } else {
                  chartState.pendingSession = sid
                }
              } else {
                chartState.pendingSession = null
              }
            }
            // 主题色每 900ms 刷一次
            if (wall - (chartState.lastTheme || 0) > 900) {
              chartState.lastTheme = wall
              try {
                store.theme = detectTheme()
                store.palette = canvasPalette(hostRef.current, store.themeMode)
              } catch (e) {}
            }
            if (chartState.worker) {
              if (wall - (chartState.lastState || 0) >= 50) {
                chartState.lastState = wall
                chartState.worker.postMessage({
                  type: 'state',
                  cur: readSpeed(frame),
                  w10: curveAverage(10),
                  peak: windowPeak(wall),
                  total: frame ? Number(frame.tokensEst) || 0 : 0,
                  theme: store.themeMode
                })
              }
              if (wall - (chartState.lastPoints || 0) >= 16) {
                chartState.lastPoints = wall
                var chart = computePoints(store.ring, wall)
                // 只发新增的采样。游标用单调递增的写入序号，而不是数组下标：
                // 缓冲被 shift 修剪后长度不变，下标游标会永远停在 900、再也不会发点。
                var ringBuf = store.ring
                var total = ringBuf.length
                var seq = store.ringSeq || 0
                var cursor = chartState.cursor || 0
                var pending = seq - cursor
                if (pending < 0 || pending > total) pending = total
                var pairs = []
                // 以缓冲里最新一个采样为基准算 age，切回旧会话时整段曲线重新贴到右端
                var ref = total > 0 ? ringBuf[total - 1].t : wall
                for (var ci = total - pending; ci < total; ci += 1) {
                  pairs.push(ref - ringBuf[ci].t, ringBuf[ci].v)
                }
                chartState.cursor = seq
                chartState.worker.postMessage({
                  type: 'add',
                  pairs: pairs,
                  top: chart.top,
                  ringLast: chart.ringLast,
                  live: !!(store.lastAt && wall - store.lastAt < 2000)
                })
                if (wall - (chartState.lastPalette || 0) > 900) {
                  chartState.lastPalette = wall
                  chartState.worker.postMessage({ type: 'palette', colors: store.palette || canvasPalette(hostRef.current) })
                }
              }
            }
          } catch (e) {
            if (!chartState.error) chartState.error = String((e && e.message) || e)
          }
        }
        requestAnimationFrame(tick)
        return function () { alive = false }
      }, [mode])

      var gaugeIcon = h('svg', {
        className: 'dsg-toggle-icon', width: 14, height: 14, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round'
      },
        h('path', { d: 'M4 17a8 8 0 0 1 16 0' }),
        h('path', { d: 'M12 17l4-6' }),
        h('circle', { cx: 12, cy: 17, r: 1.4, fill: 'currentColor', stroke: 'none' })
      )

      var bar = h('div', { className: 'dsg-bar' },
        h('div', {
          className: 'dsg-dock',
          ref: hostRef,
          role: 'group',
          'aria-label': T.title,
          style: enabled ? undefined : { display: 'none' }
        },
          h('canvas', { className: 'dsg-panel', ref: canvasRef }),
          h('button', {
            className: 'dsg-reset-hit',
            type: 'button',
            title: T.reset,
            'aria-label': T.reset,
            onClick: resetAll
          }),
          mode === 'fallback' ? h('div', { className: 'dsg-fallback' }, h('span', { ref: fallbackRef }, T.estimate)) : null
        )
      )

      if (ReactDOM && typeof ReactDOM.createPortal === 'function' && anchorEl) {
        try { return ReactDOM.createPortal(bar, anchorEl) } catch (e) {}
      }
      return null
    }

    // ---------- 错误边界 ----------
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: (error && error.message) || 'render failed' }
      }
      componentDidCatch(error) {
        try { console.error('[dsh-speed-gauge]', error) } catch (e) {}
      }
      render() {
        if (this.state.error) {
          var T = pickText()
          return h('div', { className: 'dsg-dock', style: { color: '#ff9b9b', fontSize: '11px' }, title: String(this.state.error) }, T.err)
        }
        return this.props.children
      }
    }

    function apply(ctx) {
      try {
        ensureStyle()
        // 常驻挂载点：shell.overlay 一直都在；真正的界面由 portal 放进会话 header 下面。
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'speed-gauge', order: 30 }, function () {
            return h(Boundary, null, h(SpeedGauge))
          })
        })
      } catch (error) {
        try { console.warn('[dsh-speed-gauge] mount skipped:', error) } catch (e) {}
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = NAME
    // 仅给离线测试用：量程回落的纯函数、曲线几何与状态。
    exports.__test = { niceTop, currentSparkScale, windowRate, store, SPARK_MIN_TOP, computePoints, SPARK_SPAN }
    return module.exports
  }
})
