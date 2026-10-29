/* ═══════════════════════════════════════════════════════════════════════════
   token-waster — UI
   No framework, no build step. The whole app is: read a form, POST it, then
   animate whatever the server says came back.
   ═══════════════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');

const state = {
  catalog: null,
  provider: null,
  model: null,
  strategy: 'max-output',
  running: false,
  snap: null,
  display: { tokens: 0, input: 0, output: 0, cached: 0 },
  target: { tokens: 0, input: 0, output: 0, cached: 0, tps: 0 },
  intensity: 0,
  intensityTarget: 0,
};

/* ── boot ─────────────────────────────────────────────────────────────────── */

async function boot() {
  const res = await fetch('/api/bootstrap');
  const data = await res.json();
  state.catalog = data;
  $('ver').textContent = `v0.1 · catalog ${data.catalogVersion}`;
  $('footCat').textContent = `价格表 ${data.catalogVersion}（可能过时，以账单为准）`;

  const sel = $('provider');
  sel.innerHTML = '';
  for (const p of data.providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.value = 'openai';
  onProviderChange();

  if (data.status && data.status.state !== 'idle') {
    state.snap = data.status;
    applyRunConfig(data.status.config);
    // Paint the current numbers immediately instead of waiting for the first
    // SSE frame — a reload mid-run should look like a reload, not a reset.
    applySnapshot(data.status);
    state.display.tokens = state.target.tokens;
    state.display.input = state.target.input;
    state.display.output = state.target.output;
    state.display.cached = state.target.cached;
    if (data.status.state === 'running' || data.status.state === 'stopping') setRunning(true);
  }

  connectStream();
}

/** Mirror the running config back into the form, so a reload shows what is
 *  actually burning rather than whatever the defaults were. The API key is
 *  never sent back down, so that field stays empty by design. */
function applyRunConfig(cfg) {
  if (!cfg) return;
  const known = state.catalog.providers.some((p) => p.id === cfg.providerId);
  if (known) {
    $('provider').value = cfg.providerId;
    onProviderChange();
  }
  if (cfg.baseUrl) $('baseUrl').value = cfg.baseUrl;
  if (cfg.modelId) {
    $('modelId').value = cfg.modelId;
    onModelChange();
  }
  if (cfg.concurrency) $('concurrency').value = cfg.concurrency;
  if (typeof cfg.contextFill === 'number') $('contextFill').value = Math.round(cfg.contextFill * 100);
  if (typeof cfg.imageSize === 'number') $('imageSize').value = cfg.imageSize;
  if (typeof cfg.imageCount === 'number') $('imageCount').value = cfg.imageCount;
  syncSliderLabels();
}

async function connectStream() {
  const es = new EventSource('/api/run/stream');

  es.addEventListener('tick', (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener('done', (e) => {
    const s = JSON.parse(e.data);
    applySnapshot(s);
    setRunning(false);
    $('report').disabled = false;
    toast(
      `烧完了 — ${reasonText(s.stopReason)} · ${nf.format(s.total || 0)} token · $${(s.costUsd || 0).toFixed(2)}`,
    );
  });
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));

  es.onerror = () => {
    /* EventSource retries on its own */
  };
}

/* ── provider / model wiring ──────────────────────────────────────────────── */

function onProviderChange() {
  const id = $('provider').value;
  const p = state.catalog.providers.find((x) => x.id === id);
  state.provider = p;
  if (!p) return;

  $('baseUrl').value = p.baseUrl;
  $('providerHint').textContent = p.notes || '';
  $('providerHint').title = p.limitsNote || '';

  const dl = $('modelList');
  dl.innerHTML = '';
  for (const m of p.models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.label = `${m.id} · ctx ${nf.format(m.ctx)} · out ${nf.format(m.maxOut)}${m.est ? ' · 估价' : ''}`;
    dl.appendChild(o);
  }

  const first = p.models[0];
  $('modelId').value = first ? first.id : '';
  onModelChange();

  // Sensible per-vendor defaults for the image knobs.
  const edge = p.imageLongEdge || 1536;
  $('imageSize').value = Math.min(2048, Math.max(512, edge));
  syncSliderLabels();
}

function onModelChange() {
  const p = state.provider;
  if (!p) return;
  const id = $('modelId').value.trim();
  const m = p.models.find((x) => x.id === id);
  state.model = m || null;

  if (m) {
    $('ctx').value = m.ctx;
    $('maxOut').value = m.maxOut;
    $('priceIn').value = m.price.in;
    $('priceOut').value = m.price.out;
    $('currency').value = m.price.currency || 'USD';
    $('modelHint').textContent =
      `ctx ${nf.format(m.ctx)} · 最大输出 ${nf.format(m.maxOut)} · ` +
      `${m.price.in}/${m.price.out} ${m.price.currency}/1M` +
      `${m.vision === false ? ' · 不支持图片' : ' · 支持图片'}` +
      `${m.est ? ' · ⚠ 价格为估价' : ''}${m.note ? ' · ' + m.note : ''}`;
  } else {
    $('modelHint').textContent = '不在内置表里 → 请手动填写下方限制与价格';
  }
  validate();
}

/* ── gate ─────────────────────────────────────────────────────────────────── */

function initGate() {
  const agree = $('gateAgree');
  const word = $('gateWord');
  const btn = $('gateEnter');

  const sync = () => {
    btn.disabled = !(agree.checked && word.value.trim().toUpperCase() === 'WASTE');
  };
  agree.addEventListener('change', sync);
  word.addEventListener('input', sync);

  btn.addEventListener('click', () => {
    $('gate').classList.add('hidden');
    sessionStorage.setItem('tw-gate', '1');
  });

  if (sessionStorage.getItem('tw-gate') === '1') $('gate').classList.add('hidden');
}

/* ── form ─────────────────────────────────────────────────────────────────── */

function validate() {
  const baseOk =
    $('agree').checked &&
    $('apiKey').value.trim().length > 0 &&
    $('modelId').value.trim().length > 0 &&
    $('baseUrl').value.trim().length > 0;

  const confirmed = $('confirmWord').value.trim().toUpperCase() === 'WASTE';

  $('ignite').disabled = !(baseOk && confirmed) || state.running;
  // Drain does not need the WASTE word — it has its own, louder confirmation.
  $('drain').disabled = !baseOk || state.running;
}

function readForm() {
  const numOr = (id, def) => {
    const v = Number($(id).value);
    return Number.isFinite(v) && $(id).value !== '' ? v : def;
  };

  const mode = $('mode').value;
  const guards = {
    maxUsd: numOr('maxUsd', 0),
    maxRequests: numOr('maxRequests', 0),
    maxDurationSec: numOr('maxDurationSec', 0),
    maxTokens: 0,
  };
  // In "time" mode the target *is* a duration, so it has to reach the guard the
  // server actually enforces — but it must not *overwrite* a stricter cap the
  // user set by hand. Take the smaller of the two.
  if (mode === 'time') {
    const target = numOr('targetValue', 120);
    guards.maxDurationSec = guards.maxDurationSec > 0 ? Math.min(guards.maxDurationSec, target) : target;
  }

  return {
    providerId: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    modelId: $('modelId').value.trim(),
    strategy: state.strategy,
    mode,
    targetValue: numOr('targetValue', 0),
    concurrency: numOr('concurrency', 4),
    contextFill: numOr('contextFill', 25) / 100,
    imageCount: numOr('imageCount', 4),
    imageSize: numOr('imageSize', 1536),
    effort: $('effort').value || null,
    thinkingBudget: numOr('thinkingBudget', 0),
    shortOutput: $('shortOutput').checked,
    confirm: $('confirmWord').value.trim(),
    guards,
    model: {
      ctx: numOr('ctx', 128000),
      maxOut: numOr('maxOut', 4096),
      priceIn: numOr('priceIn', 0),
      priceOut: numOr('priceOut', 0),
      currency: $('currency').value,
      vision: state.model ? state.model.vision !== false : true,
    },
  };
}

async function ignite() {
  if (state.running) return;
  await launch(readForm(), { drain: false });
}

/**
 * 无忧燃尽: no target, no money cap. The provider's "insufficient quota" reply is
 * what ends this, which is why it needs its own confirmation word.
 */
async function startDrain() {
  if (state.running) return;
  const form = readForm();
  const body = {
    ...form,
    mode: 'drain',
    confirm: 'BURN',
    // Pure output is the most expensive thing a model can do, so that is what
    // "burn it all" means in practice.
    strategy: 'max-output',
    shortOutput: false,
    concurrency: Math.max(8, Number($('concurrency').value) || 4),
    // Zeros mean "no ceiling": the server substitutes its own hard stops
    // (6h / 20k requests) because a run with no bound at all is refused.
    guards: { maxUsd: 0, maxRequests: 0, maxDurationSec: 0, maxTokens: 0 },
  };

  closeDrainConfirm();
  await launch(body, { drain: true });
}

async function launch(body, { drain = false } = {}) {
  const btn = drain ? $('drain') : $('ignite');
  const label = drain ? btn.querySelector('.dr-t') : btn.querySelector('.ig-label');
  const original = label.textContent;

  btn.disabled = true;
  label.textContent = drain ? '点燃中…' : '点火中…';

  try {
    const res = await fetch('/api/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    $('log').innerHTML = '';
    state.display = { tokens: 0, input: 0, output: 0, cached: 0 };
    state.target = { tokens: 0, input: 0, output: 0, cached: 0, tps: 0 };
    setRunning(true);
    if (drain) toast('无忧燃尽已开始。它会一直跑到服务商拒绝为止。');
  } catch (err) {
    toast(err.message, true);
    label.textContent = original;
    validate();
  }
}

function closeDrainConfirm() {
  $('drainConfirm').classList.remove('open');
  $('drainWord').value = '';
  $('drainGo').disabled = true;
}

async function openReport() {
  if (!state.snap) return toast('还没有运行记录', true);
  const w = window.open('/api/report?auto=1', '_blank');
  if (!w) toast('浏览器拦截了新窗口，请允许弹窗后重试', true);
}

async function kill() {
  try {
    await fetch('/api/run/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast('已发出停止指令，正在收回在途请求…');
  } catch {
    toast('停止请求失败，请直接关闭终端', true);
  }
}

function setRunning(on) {
  state.running = on;
  const st = $('status');
  st.className = 'status' + (on ? ' live' : state.snap ? ' done' : '');
  st.querySelector('span').textContent = on ? '燃烧中' : state.snap && state.snap.state === 'done' ? '已熄灭' : '待机';

  $('ignite').disabled = on;
  $('ignite').querySelector('.ig-label').textContent = on ? '正在烧' : '点火';
  // The drain button keeps its label: two buttons reading "正在烧" is worse than
  // one disabled button that still says what it would do.
  $('drain').disabled = on;
  $('kill').disabled = !on;
  // Lock the form while a run is live: editing it would suggest the running job
  // could be changed, which it cannot.
  $('panelBody').inert = on;
  if (!on) closeDrainConfirm();
  $('counter').classList.toggle('hot', on);

  if (!on) state.intensityTarget = 0;
}

/* ── snapshot → UI ────────────────────────────────────────────────────────── */

function applySnapshot(s) {
  if (!s) return;
  state.snap = s;

  state.target.tokens = s.total || 0;
  state.target.input = s.input || 0;
  state.target.output = s.output || 0;
  state.target.cached = s.cached || 0;
  state.target.tps = s.tokensPerSec || 0;

  state.intensityTarget = Math.min(1, (s.tokensPerSec || 0) / 5000);

  $('gUsd').innerHTML = `$${(s.usdPerMin || 0).toFixed(4)}<span>/min</span>`;
  $('gTps').innerHTML = `${nf.format(s.tokensPerSec || 0)}<span>/s</span>`;
  $('gCost').textContent = `$${(s.costUsd || 0).toFixed(4)}`;
  $('gReq').innerHTML =
    `${nf.format(s.requests || 0)}<span> / ${nf.format(s.failed || 0)} 失败` +
    `${s.permits ? ` · 并发 ${s.permits}` : ''}</span>`;
  $('report').disabled = false;

  updateProgress(s);

  if (s.state === 'running' || s.state === 'stopping') {
    if (!state.running) setRunning(true);
  } else if (s.state === 'done' && state.running) {
    setRunning(false);
  }
}

function updateProgress(s) {
  const lim = s.limits || {};
  let value = s.total || 0;
  let total = 0;
  let label = 'token 进度';
  let fmt;

  if (Number.isFinite(lim.tokens) && lim.tokens) {
    value = s.committedTokens || s.total || 0;
    total = lim.tokens;
    label = 'token 进度';
    fmt = (v) => nf.format(Math.round(v));
  } else if (Number.isFinite(lim.usd) && lim.usd) {
    value = s.committedUsd || s.costUsd || 0;
    total = lim.usd;
    label = '预算进度';
    fmt = (v) => `$${v.toFixed(4)}`;
  } else if (Number.isFinite(lim.requests) && lim.requests) {
    // The server counts every HTTP call against this ceiling, retries included,
    // so show the same number it enforces.
    value = s.wire ?? s.requests ?? 0;
    total = lim.requests;
    label = '请求进度';
    fmt = (v) => nf.format(Math.round(v));
  } else if (Number.isFinite(lim.ms) && lim.ms) {
    value = s.elapsedMs || 0;
    total = lim.ms;
    label = '时长进度';
    fmt = (v) => `${(v / 1000).toFixed(1)}s`;
  } else {
    fmt = (v) => nf.format(Math.round(v));
  }

  $('pLabel').textContent = label;

  if (total > 0) {
    const pct = Math.min(100, (value / total) * 100);
    $('pFill').style.width = `${pct}%`;
    $('pText').textContent = `${fmt(value)} / ${fmt(total)}  ·  ${pct.toFixed(1)}%`;
  } else {
    $('pFill').style.width = '0%';
    $('pText').textContent = `${fmt(value)} · 未设目标`;
  }
}

function appendLog(entry) {
  const box = $('log');
  if (box.querySelector('.empty')) box.innerHTML = '';
  const row = document.createElement('div');
  row.className = `row ${entry.level}`;
  const t = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false });
  row.innerHTML = `<span class="t">${t}</span><span class="m"></span>`;
  row.querySelector('.m').textContent = entry.msg;
  box.appendChild(row);
  while (box.children.length > 220) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ── number animation ─────────────────────────────────────────────────────── */

function animateNumbers() {
  const d = state.display;
  const t = state.target;
  const k = 0.14;

  d.tokens += (t.tokens - d.tokens) * k;
  d.input += (t.input - d.input) * k;
  d.output += (t.output - d.output) * k;
  d.cached += (t.cached - d.cached) * k;

  if (Math.abs(t.tokens - d.tokens) < 0.6) d.tokens = t.tokens;
  if (Math.abs(t.input - d.input) < 0.6) d.input = t.input;
  if (Math.abs(t.output - d.output) < 0.6) d.output = t.output;
  if (Math.abs(t.cached - d.cached) < 0.6) d.cached = t.cached;

  $('counter').textContent = nf.format(Math.round(d.tokens));
  $('counterIn').textContent = `in ${nf.format(Math.round(d.input))}`;
  $('counterOut').textContent = `out ${nf.format(Math.round(d.output))}`;
  $('counterCached').textContent = `cached ${nf.format(Math.round(d.cached))}`;

  state.intensity += (state.intensityTarget - state.intensity) * 0.05;
  // Snap up on the first frame of a run so a screenshot taken immediately
  // after ignition is not a cold, fireless page.
  if (state.intensity < 0.08 && state.intensityTarget > 0.3) state.intensity = state.intensityTarget * 0.7;

  requestAnimationFrame(animateNumbers);
}

/* ── fire ─────────────────────────────────────────────────────────────────── */

const fire = $('fire');
const fctx = fire.getContext('2d');
let dpr = Math.min(2, window.devicePixelRatio || 1);
let particles = [];
let emberAcc = 0;
let warmed = false;

/**
 * Pre-rendered ember sprites. Drawing 800 `drawImage` calls per frame is
 * cheap; drawing 800 radial gradients per frame is not, and this runs behind a
 * 250 ms dashboard refresh.
 */
const SPARKS = (() => {
  const hues = [42, 30, 18, 8];
  return hues.map((hue) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `hsla(${hue + 18}, 100%, 84%, 1)`);
    g.addColorStop(0.28, `hsla(${hue + 6}, 100%, 62%, 0.72)`);
    g.addColorStop(0.62, `hsla(${hue}, 100%, 48%, 0.24)`);
    g.addColorStop(1, `hsla(${hue - 6}, 100%, 40%, 0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return c;
  });
})();

function resizeFire() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  fire.width = Math.floor(window.innerWidth * dpr);
  fire.height = Math.floor(window.innerHeight * 0.42 * dpr);
  fire.style.height = '42vh';
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnParticle() {
  const w = window.innerWidth;
  const h = fire.height / dpr;
  const i = state.intensity;

  // Embers are born along a wide bed, not a point, and drift up a short arc.
  const spread = w * (0.42 + i * 0.4);
  particles.push({
    x: w / 2 + (Math.random() - 0.5) * spread,
    y: h - Math.random() * 14,
    vx: (Math.random() - 0.5) * 0.7,
    vy: -(0.5 + Math.random() * 2.2) * (0.55 + i * 1.1),
    life: 1,
    decay: 0.006 + Math.random() * 0.012,
    r: 3 + Math.random() * 14 * (0.6 + i * 0.9),
    spark: (Math.random() * SPARKS.length) | 0,
  });
}

function drawFire() {
  const w = window.innerWidth;
  const h = fire.height / dpr;
  const i = state.intensity;
  const now = performance.now() / 1000;

  fctx.clearRect(0, 0, w, h);
  fctx.globalCompositeOperation = 'lighter';

  // Pre-fill the plume so the first painted frame already looks lit.
  if (!warmed) {
    for (let n = 0; n < 320; n++) {
      spawnParticle();
      const p = particles[particles.length - 1];
      p.y -= Math.random() * h * 0.6;
      p.life = 0.2 + Math.random() * 0.8;
    }
    warmed = true;
  }

  // ── the bed: a smouldering band along the very bottom
  const bedH = h * 0.34;
  const bed = fctx.createLinearGradient(0, h, 0, h - bedH);
  bed.addColorStop(0, `rgba(255, 150, 40, ${0.16 + i * 0.3})`);
  bed.addColorStop(0.35, `rgba(255, 74, 0, ${0.07 + i * 0.16})`);
  bed.addColorStop(1, 'rgba(120, 16, 0, 0)');
  fctx.fillStyle = bed;
  fctx.fillRect(0, h - bedH, w, bedH);

  // ── tongues: tapered columns, softened by a canvas blur so the silhouette
  //    reads as flame rather than as geometry. Five columns is enough to fill
  //    the frame; more just costs fill rate.
  const cols = 6;
  fctx.filter = 'blur(14px)';
  for (let k = 0; k < cols; k++) {
    const t = now * (0.9 + k * 0.06) + k * 1.37;
    const cx = w * (0.08 + (k / (cols - 1)) * 0.84 + Math.sin(t * 0.6) * 0.02);
    const baseW = w * (0.055 + ((k * 37) % 11) / 220);
    const height = h * (0.26 + i * 0.62) * (0.72 + Math.abs(Math.sin(k * 2.1)) * 0.5);
    const sway = Math.sin(t * 1.3) * 18;

    fctx.beginPath();
    fctx.moveTo(cx - baseW / 2, h);
    fctx.quadraticCurveTo(cx - baseW * 0.34 + sway, h - height * 0.55, cx + sway * 1.8, h - height);
    fctx.quadraticCurveTo(cx + baseW * 0.34 + sway, h - height * 0.55, cx + baseW / 2, h);
    fctx.closePath();

    const g = fctx.createLinearGradient(0, h, 0, h - height);
    g.addColorStop(0, `rgba(255, 214, 132, ${0.24 + i * 0.24})`);
    g.addColorStop(0.28, `rgba(255, 132, 20, ${0.17 + i * 0.2})`);
    g.addColorStop(0.62, `rgba(255, 62, 0, ${0.08 + i * 0.15})`);
    g.addColorStop(1, 'rgba(180, 24, 0, 0)');
    fctx.fillStyle = g;
    fctx.fill();
  }
  fctx.filter = 'none';

  // ── embers
  emberAcc += 0.6 + i * 5;
  while (emberAcc > 1) {
    spawnParticle();
    emberAcc -= 1;
  }
  if (particles.length > 700) particles.splice(0, particles.length - 700);

  for (let n = particles.length - 1; n >= 0; n--) {
    const p = particles[n];
    p.x += p.vx;
    p.y += p.vy;
    p.vy *= 0.998;
    p.vx += (Math.random() - 0.5) * 0.1;
    p.life -= p.decay;
    p.r *= 0.997;

    if (p.life <= 0 || p.y < -30) {
      particles.splice(n, 1);
      continue;
    }

    fctx.globalAlpha = Math.max(0, p.life) ** 1.8 * (0.1 + i * 0.3);
    fctx.drawImage(SPARKS[p.spark], p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }

  fctx.globalAlpha = 1;
  fctx.globalCompositeOperation = 'source-over';

  requestAnimationFrame(drawFire);
}

/* ── misc ui ──────────────────────────────────────────────────────────────── */

function syncSliderLabels() {
  const set = (id, out, fmt) => {
    const el = $(id);
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--pct', `${pct}%`);
    if (out) $(out).textContent = fmt ? fmt(el.value) : el.value;
  };
  set('concurrency', 'concVal');
  set('contextFill', 'fillVal', (v) => `${v}%`);
  set('imageCount', 'imgVal');
  set('imageSize', 'sizeVal');
  set('thinkingBudget', 'thinkVal', (v) => (Number(v) === 0 ? '关' : nf.format(v)));
}

function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 4200);
}

function reasonText(r) {
  if (!r) return '未知原因';
  if (/token target/.test(r)) return '达到 token 目标';
  if (/budget/.test(r)) return '达到金额上限';
  if (/request limit/.test(r)) return '达到请求数上限';
  if (/time limit/.test(r)) return '达到时长上限';
  if (/user/.test(r)) return '你按下了停止';
  if (/account drained/.test(r)) return '账户已燃尽';
  if (/fatal/.test(r)) return `致命错误：${r.replace(/^fatal:\s*/, '')}`;
  return r;
}

const STRATEGY_HINT = {
  'max-output':
    '把 max_tokens 拉满，用"禁止总结/禁止省略"的指令逼模型持续输出。输出 token 最贵，这条路烧钱最快。',
  'image-bomb':
    '塞满低熵大图。计费按像素、不按文件大小 —— 几十 KB 的 PNG 能顶几千 token 的输入。适合测视觉通道。',
  mixed: '图文一起上：输入填到上下文的 25%，图片再吃掉一大块，剩下的全部让模型写完。',
};

/* ── events ───────────────────────────────────────────────────────────────── */

function bind() {
  $('provider').addEventListener('change', onProviderChange);
  $('modelId').addEventListener('input', onModelChange);
  $('modelId').addEventListener('change', onModelChange);

  for (const id of ['agree', 'confirmWord', 'apiKey']) {
    $(id).addEventListener('input', validate);
    $(id).addEventListener('change', validate);
  }

  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });

  $('strategy').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    state.strategy = b.dataset.v;
    for (const x of $('strategy').children) x.classList.toggle('on', x === b);
    $('strategyHint').textContent = STRATEGY_HINT[state.strategy] || '';
  });

  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    $('targetValue').value = b.dataset.v;
  });

  $('mode').addEventListener('change', () => {
    const m = $('mode').value;
    const label = $('targetLabel');
    const unit = { tokens: ['目标 token', '1000000', '1000'], usd: ['目标金额 $', '2', '0.5'], requests: ['目标请求数', '200', '10'], time: ['目标时长（秒）', '120', '30'] }[m];
    label.textContent = unit[0];
    $('targetValue').value = unit[1];
    $('targetValue').step = unit[2];
    $('presets').style.display = m === 'tokens' ? 'flex' : 'none';
  });

  for (const id of ['concurrency', 'contextFill', 'imageCount', 'imageSize', 'thinkingBudget']) {
    $(id).addEventListener('input', syncSliderLabels);
  }

  $('ignite').addEventListener('click', ignite);
  $('kill').addEventListener('click', kill);
  $('report').addEventListener('click', openReport);

  $('drain').addEventListener('click', () => {
    const box = $('drainConfirm');
    const open = box.classList.toggle('open');
    if (open) {
      $('drainWord').value = '';
      $('drainGo').disabled = true;
      $('drainWord').focus();
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  $('drainWord').addEventListener('input', (e) => {
    $('drainGo').disabled = e.target.value.trim().toUpperCase() !== 'BURN';
  });
  $('drainWord').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('drainGo').disabled) startDrain();
  });
  $('drainGo').addEventListener('click', startDrain);
  $('drainCancel').addEventListener('click', closeDrainConfirm);
  $('clearLog').addEventListener('click', () => {
    $('log').innerHTML = '<div class="row empty"><span class="m">清空了。</span></div>';
  });

  $('collapse').addEventListener('click', () => {
    const p = $('panel');
    p.classList.toggle('collapsed');
    $('collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.running) kill();
  });

  $('probe').addEventListener('click', async () => {
    const out = $('probeOut');
    out.className = 'probe-out';
    out.textContent = '测试中…';
    try {
      const res = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: $('provider').value,
          baseUrl: $('baseUrl').value.trim(),
          apiKey: $('apiKey').value.trim(),
          modelId: $('modelId').value.trim(),
        }),
      });
      const d = await res.json();
      if (d.ok) {
        out.className = 'probe-out ok';
        out.textContent = `${d.ms}ms · in ${d.usage.input} / out ${d.usage.output}`;
      } else {
        out.className = 'probe-out bad';
        out.textContent = (d.error || '失败').slice(0, 60);
        out.title = d.error || '';
      }
    } catch (err) {
      out.className = 'probe-out bad';
      out.textContent = err.message;
    }
  });

  window.addEventListener('resize', resizeFire);
}

/* ── go ───────────────────────────────────────────────────────────────────── */

initGate();
bind();
syncSliderLabels();
$('strategyHint').textContent = STRATEGY_HINT['max-output'];
$('log').innerHTML = '<div class="row empty"><span class="m">还没开始。</span></div>';
$('report').disabled = true;
resizeFire();
requestAnimationFrame(drawFire);
requestAnimationFrame(animateNumbers);
boot().catch((e) => toast(`启动失败：${e.message}`, true));
