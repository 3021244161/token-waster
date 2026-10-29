/**
 * Run report.
 *
 * Why HTML and not a PDF byte stream: a real PDF needs an embedded CJK font to
 * render Chinese at all, which means shipping megabytes of font data or
 * shelling out to a headless browser — both of which break the zero-dependency
 * promise. A print-styled HTML page gets you the exact same artefact through the
 * browser's own "Save as PDF", with correct fonts, selectable text and vector
 * charts. The button in the UI calls this with ?auto=1 and the print dialog
 * opens on its own.
 */

import { toUsd } from './config.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const nf = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n, d = 4) => `$${Number(n || 0).toFixed(d)}`;
const pct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;

function dur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}h ${m}m ${ss}s`;
  if (m) return `${m}m ${ss}s`;
  return `${ss}s`;
}

/* ── charts ───────────────────────────────────────────────────────────────── */

function areaChart(points, { w = 720, h = 180, key = 'total', color = '#ff5a00' } = {}) {
  if (!points || points.length < 2) {
    return `<div class="empty-chart">运行时间太短，没有足够的数据点画曲线</div>`;
  }
  const maxX = points[points.length - 1].t || 1;
  const maxY = Math.max(1, ...points.map((p) => p[key] || 0));
  const pad = { l: 6, r: 6, t: 10, b: 18 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const x = (t) => pad.l + (t / maxX) * iw;
  const y = (v) => pad.t + ih - (v / maxY) * ih;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(maxX).toFixed(1)},${(pad.t + ih).toFixed(1)} L${pad.l},${(pad.t + ih).toFixed(1)} Z`;

  const gid = `g${key}`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none" role="img">
  <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${color}" stop-opacity="0.30"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
  </linearGradient></defs>
  <line x1="${pad.l}" y1="${pad.t + ih}" x2="${w - pad.r}" y2="${pad.t + ih}" stroke="#e6e1dc" stroke-width="1"/>
  <path d="${area}" fill="url(#${gid})"/>
  <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export function renderReport(data, { autoPrint = false } = {}) {
  const s = data.snapshot || {};
  const tl = data.timeline || [];
  const logs = data.logs || [];
  const model = data.model || {};
  const provider = data.provider || {};

  const startedAt = data.startedAt ? new Date(data.startedAt) : new Date();
  const endedAt = data.endedAt ? new Date(data.endedAt) : new Date();

  const attempted = (s.ok || 0) + (s.failed || 0);
  const avgRate = s.elapsedMs ? Math.round(((s.total || 0) / s.elapsedMs) * 1000) : 0;
  const peakRate = tl.length ? Math.max(...tl.map((p) => p.rate || 0)) : 0;

  const price = model.price || { in: 0, out: 0, currency: 'USD' };
  const cur = price.currency === 'CNY' ? '¥' : price.currency === 'EUR' ? '€' : '$';
  const inTokens = s.input || 0;
  const outTokens = s.output || 0;
  const cachedTokens = s.cached || 0;

  // The ledger is in USD (see estimateCostUsd). The line items have to be too,
  // otherwise a CNY-priced model shows ¥12 line items summing to a $ total.
  const fx = toUsd(1, price.currency || 'USD');
  const inRate = toUsd(price.in, price.currency || 'USD');
  const outRate = toUsd(price.out, price.currency || 'USD');
  const rateLabel = (v) => (fx === 1 ? `${cur}${v}` : `${cur}${v} <span style="color:#a89e95">($${(v * fx).toFixed(2)})</span>`);

  // Split the bill so the report says *why* it cost what it did.
  const uncachedIn = Math.max(0, inTokens - cachedTokens);
  const inCost = (uncachedIn * inRate) / 1e6 + (cachedTokens * inRate * 0.2) / 1e6;
  const outCost = (outTokens * outRate) / 1e6;

  const reasonMap = {
    'account drained': '账户余额耗尽',
    'token target reached': '达到 token 目标',
    'budget reached': '达到金额上限',
    'request limit reached': '达到请求数上限',
    'time limit reached': '达到时长上限',
    'stopped by user': '手动停止',
    'run complete': '正常结束',
  };
  const reasonKey = String(s.stopReason || '');
  const reason =
    Object.entries(reasonMap).find(([k]) => reasonKey.startsWith(k))?.[1] ||
    (reasonKey.startsWith('fatal') ? `异常终止：${reasonKey.replace(/^fatal:\s*/, '').slice(0, 90)}` : reasonKey || '未知');

  const okRate = attempted ? (s.ok || 0) / attempted : 0;

  const logRows = logs
    .slice(-70)
    .map((l) => {
      const t = new Date(l.at).toLocaleTimeString('en-GB', { hour12: false });
      return `<tr class="lvl-${esc(l.level)}"><td class="t">${t}</td><td>${esc(l.msg)}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>token-waster 运行报告 · ${esc(startedAt.toLocaleString('zh-CN'))}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 30px 40px;
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #14110f; background: #fff; font-size: 12.5px; line-height: 1.6;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #14110f; padding-bottom: 14px; margin-bottom: 22px; }
  .brand { font-family: ui-monospace, Menlo, monospace; font-weight: 800; letter-spacing: .22em; font-size: 13px; }
  .brand span { color: #e04a00; }
  h1 { font-size: 26px; margin: 6px 0 0; letter-spacing: -.02em; }
  .meta { text-align: right; font-size: 11px; color: #6b6159; line-height: 1.7; }
  .hero { display: flex; gap: 26px; align-items: flex-end; margin: 0 0 8px; }
  .hero .big { font-family: ui-monospace, Menlo, monospace; font-size: 52px; font-weight: 800;
    letter-spacing: -.04em; line-height: 1; color: #e04a00; }
  .hero .unit { font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .2em;
    color: #8a7d72; text-transform: uppercase; padding-bottom: 6px; }
  .hero .side { margin-left: auto; text-align: right; }
  .hero .side .v { font-family: ui-monospace, Menlo, monospace; font-size: 22px; font-weight: 700; }
  .hero .side .k { font-family: ui-monospace, Menlo, monospace; font-size: 10px; letter-spacing: .14em; color: #8a7d72; }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #e8e3dd;
    border: 1px solid #e8e3dd; margin: 20px 0 24px; }
  .cell { background: #fff; padding: 12px 14px; }
  .cell .k { font-family: ui-monospace, Menlo, monospace; font-size: 9.5px; letter-spacing: .13em;
    color: #8a7d72; text-transform: uppercase; margin-bottom: 4px; }
  .cell .v { font-family: ui-monospace, Menlo, monospace; font-size: 17px; font-weight: 650; }

  h2 { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; letter-spacing: .2em;
    text-transform: uppercase; color: #8a7d72; margin: 26px 0 10px;
    border-bottom: 1px solid #e8e3dd; padding-bottom: 6px; font-weight: 600; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f0ece7; }
  th { font-family: ui-monospace, Menlo, monospace; font-size: 9.5px; letter-spacing: .1em;
    text-transform: uppercase; color: #8a7d72; font-weight: 600; }
  td.num, th.num { text-align: right; font-family: ui-monospace, Menlo, monospace; }
  tr.total td { border-top: 2px solid #14110f; font-weight: 700; }

  .chart { width: 100%; height: 150px; display: block; }
  .empty-chart { padding: 34px; text-align: center; color: #b0a69d; font-size: 11.5px;
    border: 1px dashed #e8e3dd; border-radius: 6px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }

  .note { background: #fbf7f3; border-left: 3px solid #e04a00; padding: 12px 14px;
    font-size: 11.5px; color: #5c534c; margin-top: 22px; }
  .note b { color: #14110f; }

  .logs { font-family: ui-monospace, Menlo, monospace; font-size: 10px; line-height: 1.55; }
  .logs td { padding: 2px 6px; border: 0; }
  .logs .t { color: #a89e95; white-space: nowrap; width: 62px; }
  .logs .lvl-ok td:last-child { color: #2f6b3c; }
  .logs .lvl-warn td:last-child { color: #a35a00; }
  .logs .lvl-error td:last-child { color: #a11d1d; }

  footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e8e3dd;
    font-size: 10px; color: #a89e95; font-family: ui-monospace, Menlo, monospace;
    display: flex; justify-content: space-between; gap: 16px; }

  .bar { position: fixed; top: 0; left: 0; right: 0; background: #14110f; color: #fff;
    padding: 10px 16px; display: flex; justify-content: space-between; align-items: center;
    font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .08em; }
  .bar button { background: #e04a00; color: #fff; border: 0; padding: 7px 14px; border-radius: 5px;
    font-family: inherit; font-size: 11px; letter-spacing: .1em; cursor: pointer; font-weight: 700; }
  .bar button:hover { background: #ff5a00; }
  body.printing { padding-top: 56px; }

  @media print {
    body { padding: 0; }
    .bar { display: none; }
    body.printing { padding-top: 0; }
    .page { break-inside: avoid; }
    h2 { break-after: avoid; }
    table { break-inside: auto; }
    tr { break-inside: avoid; }
  }
</style>
</head>
<body class="${autoPrint ? 'printing' : ''}">

<div class="bar">
  <span>TOKEN WASTER · 运行报告</span>
  <button onclick="window.print()">打印 / 保存为 PDF</button>
</div>

<header>
  <div>
    <div class="brand">TOKEN<span>WASTER</span></div>
    <h1>燃烧报告</h1>
  </div>
  <div class="meta">
    ${esc(startedAt.toLocaleString('zh-CN'))} — ${esc(endedAt.toLocaleTimeString('zh-CN'))}<br>
    时长 ${dur(s.elapsedMs)} · ${esc(provider.label || provider.id || '')}<br>
    ${esc(model.id || '')}
  </div>
</header>

<div class="hero">
  <div>
    <div class="unit">Tokens Incinerated</div>
    <div class="big">${nf(s.total)}</div>
  </div>
  <div class="side">
    <div class="v">${money(s.costUsd)}</div>
    <div class="k">Total Spend</div>
  </div>
  <div class="side">
    <div class="v">${nf(avgRate)}<span style="font-size:12px">/s</span></div>
    <div class="k">Avg Throughput</div>
  </div>
</div>

<div class="grid">
  <div class="cell"><div class="k">输入 token</div><div class="v">${nf(inTokens)}</div></div>
  <div class="cell"><div class="k">输出 token</div><div class="v">${nf(outTokens)}</div></div>
  <div class="cell"><div class="k">缓存命中</div><div class="v">${nf(cachedTokens)}</div></div>
  <div class="cell"><div class="k">请求数</div><div class="v">${nf(s.requests)}</div></div>
  <div class="cell"><div class="k">成功率</div><div class="v">${pct(okRate)}</div></div>
  <div class="cell"><div class="k">重试次数</div><div class="v">${nf(s.retries)}</div></div>
  <div class="cell"><div class="k">并发降温</div><div class="v">${nf(s.degraded)}</div></div>
  <div class="cell"><div class="k">峰值吞吐</div><div class="v">${nf(peakRate)}/s</div></div>
</div>

<h2>累积燃烧</h2>
${areaChart(tl, { key: 'total', color: '#e04a00' })}

<h2>瞬时吞吐 (token/s)</h2>
${areaChart(tl, { key: 'rate', color: '#b8860b' })}

<h2>费用构成</h2>
<table>
  <thead>
    <tr><th>项目</th><th class="num">token</th><th class="num">单价 / 1M</th><th class="num">金额</th></tr>
  </thead>
  <tbody>
    <tr><td>输入（未命中缓存）</td><td class="num">${nf(uncachedIn)}</td><td class="num">${rateLabel(price.in)}</td><td class="num">${money((uncachedIn * inRate) / 1e6)}</td></tr>
    <tr><td>输入（缓存命中，按 20% 折算）</td><td class="num">${nf(cachedTokens)}</td><td class="num">${rateLabel(Number((price.in * 0.2).toFixed(3)))}</td><td class="num">${money((cachedTokens * inRate * 0.2) / 1e6)}</td></tr>
    <tr><td>输出</td><td class="num">${nf(outTokens)}</td><td class="num">${rateLabel(price.out)}</td><td class="num">${money(outCost)}</td></tr>
    <tr class="total"><td>合计</td><td class="num">${nf(s.total)}</td><td class="num">—</td><td class="num">${money(s.costUsd)}</td></tr>
  </tbody>
</table>

<h2>运行质量</h2>
<div class="two">
  <table>
    <tr><td>结束原因</td><td class="num">${esc(reason)}</td></tr>
    <tr><td>实际并发（峰值）</td><td class="num">${nf(s.peakInflight)} / ${nf((s.config || {}).concurrency)}</td></tr>
    <tr><td>限流（429）次数</td><td class="num">${nf(s.throttled)}</td></tr>
    <tr><td>降温 / 恢复</td><td class="num">${nf(s.degraded)} / ${nf(s.recovered)}</td></tr>
  </table>
  <table>
    <tr><td>延迟 P50</td><td class="num">${nf((s.latency || {}).p50)} ms</td></tr>
    <tr><td>延迟 P90</td><td class="num">${nf((s.latency || {}).p90)} ms</td></tr>
    <tr><td>延迟 P99</td><td class="num">${nf((s.latency || {}).p99)} ms</td></tr>
    <tr><td>估算用量占比</td><td class="num">${s.requests ? pct((s.estimateOnly || 0) / s.requests) : '0%'}</td></tr>
  </table>
</div>

<h2>事件日志（最后 ${Math.min(70, logs.length)} 条）</h2>
<table class="logs">
  <tbody>${logRows || '<tr><td colspan="2">无日志</td></tr>'}</tbody>
</table>

<div class="note">
  <b>关于这份报告的数字。</b>
  token 与费用来自服务商返回的 <span class="mono">usage</span> 字段，不是本地估算；<b>只有</b>
  服务商未返回 usage 的请求才退化为字符数估算（见「估算用量占比」）。价格来自本项目的内置价格表，
  核对于 ${esc(new Date().toISOString().slice(0, 10))} 之前，<b>可能已过时</b>——最终账单以服务商结算为准。
  结束原因若显示「异常终止」，说明服务商返回了无法自动恢复的错误。
</div>

<footer>
  <span>token-waster · 本工具不产出任何内容，只消耗额度</span>
  <span>${esc(model.id || '')} · ctx ${nf(model.ctx)} · maxOut ${nf(model.maxOut)}</span>
</footer>

${autoPrint ? '<script>window.addEventListener("load", () => setTimeout(() => window.print(), 350));</script>' : ''}
</body>
</html>`;
}
