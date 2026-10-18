/* 面板渲染 Worker
 *
 * 表盘、三行统计、归零胶囊、曲线都在这里用 OffscreenCanvas 画。
 * 主线程只发数据，所以主线程忙的时候面板照常动。
 *
 * 消息：
 *   { type: 'init',    canvas, width, dpr }
 *   { type: 'layout',  width, dpr }
 *   { type: 'state',   cur, w10, peak, total, theme }
 *   { type: 'add',     pairs: [ageMs, value, ...], top, ringLast, live }
 *   { type: 'palette', colors }
 */

var canvas = null
var ctx = null
var W = 0
var DPR = 1
var H = 96
var PAD = 14

var data = { cur: 0, w10: 0, peak: 0, total: 0, top: 500, theme: 'light' }
var colors = {
  grid: 'rgba(127,127,127,.18)',
  axis: 'rgba(127,127,127,.62)',
  line: 'rgba(42,108,215,.95)',
  areaTop: 'rgba(60,120,220,.24)',
  areaBottom: 'rgba(60,120,220,0)',
  dot: '#2f6fd0',
  value: 'rgba(30,42,60,.95)',
  head: '#124fa8',
  gaugeTrack: 'rgba(120,140,170,.22)',
  gaugeFrom: '#6ec8ff',
  gaugeTo: '#7b3ff2',
  needle: 'rgba(26,42,66,.92)',
  dark: false
}

var pointTimes = []
var pointValues = []
var ringLast = 0
var live = false
var pointsAt = 0
// 临时调试开关：在曲线区左下角画点数 / 读数 / 量程 / 最新采样年龄
var DEBUG = false
var needle = 0
var needleReady = false
var sparks = []
var headSprite = null
var sparkSprite = null
var spriteKey = ''
var lastFrame = 0

function clock () { return typeof performance !== 'undefined' ? performance.now() : Date.now() }

function short (value) {
  var n = Number(value) || 0
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

function layout (width) {
  var gaugeW = Math.min(196, Math.max(150, width * 0.19))
  var statsW = 128
  var resetW = 56
  var gap = 14
  var plotStart = PAD + gaugeW + gap + statsW + gap
  var plotW = Math.max(90, width - PAD - resetW - 12 - plotStart)
  return {
    gauge: { x: PAD, y: 4, w: gaugeW, h: H - 8 },
    stats: { x: PAD + gaugeW + gap, y: 8, w: statsW, h: H - 16 },
    reset: { x: width - PAD - resetW, y: H / 2 - 11, w: resetW, h: 22 },
    plot: { x: plotStart, y: 14, w: plotW, h: H - 28 }
  }
}

function roundRect (c, x, y, w, h, r) {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

function rgb (color) {
  var str = String(color || '')
  var m = str.match(/rgba?\(([^)]+)\)/)
  if (m) {
    var p = m[1].split(',').map(Number)
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

function sprite (size, triple) {
  if (typeof OffscreenCanvas !== 'function') return null
  var s = new OffscreenCanvas(size, size)
  var g = s.getContext('2d')
  if (!g) return null
  var half = size / 2
  var grad = g.createRadialGradient(half, half, 0, half, half, half)
  grad.addColorStop(0, 'rgba(' + triple + ',0.60)')
  grad.addColorStop(0.3, 'rgba(' + triple + ',0.24)')
  grad.addColorStop(0.62, 'rgba(' + triple + ',0.07)')
  grad.addColorStop(1, 'rgba(' + triple + ',0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(half, half, half, 0, Math.PI * 2)
  g.fill()
  return s
}

function ensureSprites () {
  var key = colors.head + '|' + colors.line
  if (spriteKey === key) return
  headSprite = sprite(48, rgb(colors.head))
  sparkSprite = sprite(16, rgb(colors.line))
  spriteKey = key
}

function drawGauge (box, value) {
  var cx = box.x + box.w / 2
  var r = Math.min(box.w * 0.48, H * 0.56)
  var cy = H / 2 + (r - 16) / 2
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

function drawStats (box) {
  var rows = [
    { label: '平均', value: short(data.w10) },
    { label: '峰值', value: short(data.peak) },
    { label: '总输出', value: short(data.total) }
  ]
  var rowH = box.h / 3
  for (var i = 0; i < rows.length; i += 1) {
    var baseY = box.y + rowH * i + rowH * 0.5 + 6
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.font = '500 11px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
    ctx.fillStyle = colors.axis
    ctx.fillText(rows[i].label, box.x, baseY)
    ctx.font = '600 18px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
    ctx.fillStyle = colors.value
    ctx.fillText(rows[i].value, box.x + 62, baseY)
  }
}

function drawReset (box) {
  roundRect(ctx, box.x, box.y, box.w, box.h, box.h / 2)
  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '600 13px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
  ctx.fillStyle = colors.value
  ctx.fillText('归零', box.x + box.w / 2, box.y + box.h / 2 + 0.5)
}

function drawCurve (box, nowMs) {
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
  ctx.lineTo(box.x + box.w, yBottom - 1)
  ctx.stroke()

  // 半量程线（比如 250）：比上下两条更淡
  var yMid = (yTop + yBottom) / 2
  ctx.save()
  ctx.globalAlpha = 0.45
  ctx.beginPath()
  ctx.moveTo(box.x + 2, yMid)
  ctx.lineTo(box.x + box.w, yMid)
  ctx.stroke()
  ctx.restore()

  var top = data.top > 0 ? data.top : 500
  ctx.fillStyle = colors.axis
  ctx.fillText(short(top), box.x, yTop - 3)
  ctx.fillText(short(top / 2), box.x, (yTop + yBottom) / 2 - 3)

  var n = pointTimes.length
  if (n < 1) {
    // 还没有任何采样：画一条贴底的基准线，避免曲线区一片空白
    ctx.beginPath()
    ctx.moveTo(box.x, yBottom - 1)
    ctx.lineTo(box.x + box.w, yBottom - 1)
    ctx.strokeStyle = colors.line
    ctx.lineWidth = 1.7
    ctx.stroke()
    return
  }
  var nowWall2 = Date.now()
  var pxPerMs = box.w / 30000
  var xs = []
  var ys = []
  for (var i = 0; i < n; i += 1) {
    var age = nowWall2 - pointTimes[i]
    if (age < 0) age = 0
    var x = box.w - age * pxPerMs
    if (x < -6) continue
    var ratioY = pointValues[i] / top
    if (!isFinite(ratioY)) ratioY = 0
    var y = yBottom - Math.max(0, Math.min(1, ratioY)) * (yBottom - yTop)
    xs.push(x)
    ys.push(y)
  }
  if (xs.length === 0) {
    // 所有采样都滑出窗口了：画基准线，避免曲线区空着
    ctx.beginPath()
    ctx.moveTo(box.x, yBottom - 1)
    ctx.lineTo(box.x + box.w, yBottom - 1)
    ctx.strokeStyle = colors.line
    ctx.lineWidth = 1.7
    ctx.stroke()
    return
  }
  // 只有一个点（或都挤在右边缘）时，向右补到边界，让曲线始终可见
  if (xs.length === 1) {
    xs.push(box.w)
    ys.push(ys[0])
  }

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

  drawComet(box, xs, ys, nowMs)

  ctx.beginPath()
  ctx.moveTo(box.x + xs[0], ys[0])
  for (var b = 1; b < xs.length; b += 1) ctx.lineTo(box.x + xs[b], ys[b])
  ctx.strokeStyle = colors.line
  ctx.lineWidth = 1.7
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

function yAt (xs, ys, x) {
  var n = xs.length
  if (n === 0) return ys[0] || 0
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  var lo = 0
  var hi = n - 1
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  var span = xs[hi] - xs[lo]
  if (!(span > 0.0001)) return ys[lo]
  return ys[lo] + (ys[hi] - ys[lo]) * ((x - xs[lo]) / span)
}

function drawComet (box, xs, ys, nowMs) {
  ensureSprites()
  var headX = box.w
  var headY = ys[ys.length - 1]

  if (headSprite) {
    var pulse = 11 + Math.sin(nowMs / 240) * 0.9
    ctx.globalAlpha = colors.dark ? 0.95 : 0.85
    ctx.drawImage(headSprite, box.x + headX - pulse, headY - pulse, pulse * 2, pulse * 2)
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(box.x + headX, headY, 2.4, 0, Math.PI * 2)
  ctx.fillStyle = colors.head
  ctx.fill()

  ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = colors.value
  var vy = headY - 8
  if (vy - 12 < box.y) {
    ctx.textBaseline = 'top'
    ctx.fillText(short(data.cur), box.x + box.w + 6, headY + 10)
  } else {
    ctx.textBaseline = 'bottom'
    ctx.fillText(short(data.cur), box.x + box.w + 6, vy)
  }
}

function drawDebug (box) {
  if (!DEBUG) return
  var n = pointTimes.length
  var last = n ? (Date.now() - pointTimes[n - 1]) / 1000 : -1
  var txt = 'n=' + n +
    ' cur=' + Math.round(data.cur) +
    ' top=' + Math.round(data.top) +
    ' last=' + (last < 0 ? 'none' : last.toFixed(1) + 's')
  try {
    ctx.font = '11px ui-monospace, Consolas, monospace'
    ctx.fillStyle = 'rgba(255,120,120,0.95)'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(txt, box.x + 2, box.y + box.h - 1)
  } catch (e) {}
}

function draw () {
  if (!ctx || !canvas) return
  var nowMs = clock()
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.clearRect(0, 0, W, H)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  var box = layout(W)

  var target = data.cur
  if (!needleReady) { needle = target; needleReady = true }
  needle += (target - needle) * 0.2
  if (needle < 0.15) needle = 0

  try { drawCurve(box.plot, nowMs) } catch (e) {}
  try { drawGauge(box.gauge, needle) } catch (e) {}
  try { drawStats(box.stats) } catch (e) {}
  try { drawReset(box.reset) } catch (e) {}
  drawDebug(box.plot)
}

function resize (width, dpr) {
  if (!canvas) return
  W = width
  DPR = dpr || 1
  var bw = Math.round(W * DPR)
  var bh = Math.round(H * DPR)
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw
    canvas.height = bh
  }
  ctx = canvas.getContext('2d')
}

self.onmessage = function (event) {
  var msg = event.data || {}
  if (msg.type === 'init') {
    canvas = msg.canvas
    resize(msg.width, msg.dpr)
  } else if (msg.type === 'layout') {
    resize(msg.width, msg.dpr)
  } else if (msg.type === 'state') {
    data.cur = Number(msg.cur) || 0
    data.w10 = Number(msg.w10) || 0
    data.peak = Number(msg.peak) || 0
    data.total = Number(msg.total) || 0
    if (msg.theme) data.theme = msg.theme
  } else if (msg.type === 'reset') {
    // 切换会话：清空点集，随后客户端会整段重发
    pointTimes.length = 0
    pointValues.length = 0
  } else if (msg.type === 'add') {
    var add = msg.pairs || []
    var nowWall = Date.now()
    for (var i = 0; i < add.length; i += 2) {
      var ageIn = Number(add[i])
      var valIn = Number(add[i + 1])
      if (!isFinite(ageIn) || !isFinite(valIn)) continue
      pointTimes.push(nowWall - ageIn)
      pointValues.push(valIn)
    }
    // 只留最近 40 秒，外加一个条数上限兜底：既不会无限占内存，也够画 30 秒窗口
    var cut = nowWall - 40000
    var drop = 0
    while (drop < pointTimes.length && pointTimes[drop] < cut) drop += 1
    if (drop > 0) { pointTimes.splice(0, drop); pointValues.splice(0, drop) }
    while (pointTimes.length > 1500) { pointTimes.shift(); pointValues.shift() }
    data.top = Number(msg.top) || data.top
    ringLast = Number(msg.ringLast) || ringLast
    live = !!msg.live
  } else if (msg.type === 'palette') {
    var c = msg.colors || {}
    for (var k in colors) {
      if (Object.prototype.hasOwnProperty.call(c, k) && c[k]) colors[k] = c[k]
    }
    colors.dark = !!c.dark
    spriteKey = ''
  }
}

function loop () {
  setTimeout(loop, 16)
  try { draw() } catch (e) {}
}

loop()
