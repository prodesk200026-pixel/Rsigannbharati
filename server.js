'use strict';
const express = require('express');
const cors = require('cors');

const cfg = require('./config');
const store = require('./store');
const instruments = require('./instruments');
const { initPush, broadcast } = require('./push');
const { StrategyEngine } = require('./strategy');
const { CrossoverWatcher } = require('./straddleIvWatcher');
const { DhanBroker } = require('./brokers/dhan');
const { AngelOneBroker } = require('./brokers/angelone');

const app = express();
app.use(cors(cfg.server.corsOrigins === '*' ? {} : { origin: cfg.server.corsOrigins.split(',').map(s => s.trim()) }));
app.use(express.json());
initPush(cfg);

const dhan = new DhanBroker(cfg);
const angel = new AngelOneBroker(cfg);
const brokers = { DHAN: dhan, ANGEL: angel };
const brokerOrder = [cfg.broker.primary, cfg.broker.secondary]; // e.g. ['ANGEL','DHAN']

// ---- Per-index runtime state ----
const runtime = {};
for (const idx of cfg.trackIndices) {
  const strat = store.getStrategyConfig(idx, cfg.defaultStrategyConfig);
  runtime[idx] = {
    candles: [],
    dhanMeta: null, // resolved from the live Dhan scrip master
    call: new StrategyEngine(strat, 'CALL'),
    put: new StrategyEngine(strat, 'PUT'),
    straddleW: new CrossoverWatcher(`${idx} Straddle x Price`),
    ivW: new CrossoverWatcher(`${idx} IV x Price`),
    status: { lastUpdate: null, underlyingPrice: null, atmStrike: null, straddlePrice: null, atmIv: null, callState: 'IDLE', putState: 'IDLE', candleProvider: 'NONE', alerts: [] },
  };
}

async function refreshInstruments() {
  const resolved = await instruments.resolveAll(cfg.trackIndices, cfg.fallbackIndexMap);
  for (const idx of cfg.trackIndices) if (resolved[idx]) runtime[idx].dhanMeta = resolved[idx];
}

function requireSecret(req, res, next) {
  if (!cfg.server.apiSecret) return next();
  const secret = req.header('x-api-secret') || req.query.secret;
  if (secret !== cfg.server.apiSecret) return res.status(401).json({ error: 'bad secret' });
  next();
}

function isMarketHoursNowIST() {
  if (!cfg.polling.marketHoursOnly) return true;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

function fmtDateDhan(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function fmtDateAngel(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fetchCandlesFrom(brokerName, idx, rt) {
  const dhanMeta = rt.dhanMeta || cfg.fallbackIndexMap[idx];
  const angelMeta = cfg.angelIndexTokens[idx];
  const to = new Date();
  const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);
  if (brokerName === 'DHAN') {
    if (!dhan.isConfigured() || !dhanMeta) return null;
    return dhan.getIntradayCandles(dhanMeta.securityId, dhanMeta.exchangeSegment, rt.call.cfg.candleTimeframeMinutes, fmtDateDhan(from), fmtDateDhan(to));
  }
  if (brokerName === 'ANGEL') {
    if (!angel.isConfigured() || !angelMeta) return null;
    return angel.getIndexCandles(angelMeta, rt.call.cfg.candleTimeframeMinutes, fmtDateAngel(from), fmtDateAngel(to));
  }
  return null;
}

async function pollIndex(idx) {
  const rt = runtime[idx];
  if (!rt) return;

  // 1. candles — try in PRIMARY_BROKER / SECONDARY_BROKER order
  let candles = null, candleProvider = null;
  for (const brokerName of brokerOrder) {
    try {
      const result = await fetchCandlesFrom(brokerName, idx, rt);
      if (result && result.length) { candles = result; candleProvider = brokerName; break; }
    } catch (e) {
      console.error(`[${idx}] ${brokerName} candle fetch failed:`, e.message);
    }
  }
  if (candles && candles.length) rt.candles = candles;
  rt.status.candleProvider = candleProvider || rt.status.candleProvider || 'NONE';

  // 2. option chain — Dhan only, regardless of broker order (Angel has no
  //    native option-chain endpoint, so straddle/IV always needs Dhan)
  let optionChain = null;
  if (dhan.isConfigured()) {
    try {
      const dhanMeta = rt.dhanMeta || cfg.fallbackIndexMap[idx];
      const expiries = await dhan.getExpiryList(dhanMeta.securityId, dhanMeta.exchangeSegment);
      const nearestExpiry = expiries[0];
      if (nearestExpiry) optionChain = await dhan.getOptionChain(dhanMeta.securityId, dhanMeta.exchangeSegment, nearestExpiry);
    } catch (e) {
      console.error(`[${idx}] Dhan option-chain fetch failed:`, e.message);
    }
  }

  // 3. strategy engines
  if (rt.candles.length) {
    const evCall = rt.call.update(rt.candles);
    const evPut = rt.put.update(rt.candles);
    rt.status.callState = rt.call.state;
    rt.status.putState = rt.put.state;
    for (const ev of [evCall, evPut].filter(Boolean)) await handleStrategyEvent(idx, ev, optionChain);
  }

  // 4. straddle / IV crossover watchers
  if (optionChain) {
    const atm = DhanBroker.extractAtm(optionChain);
    if (atm) {
      rt.status.underlyingPrice = atm.underlyingPrice;
      rt.status.atmStrike = atm.strike;
      rt.status.straddlePrice = atm.straddlePrice;
      rt.status.atmIv = atm.atmIv;
      const sEv = rt.straddleW.push(atm.underlyingPrice, atm.straddlePrice);
      const iEv = rt.ivW.push(atm.underlyingPrice, atm.atmIv);
      for (const ev of [sEv, iEv].filter(Boolean)) {
        rt.status.alerts.unshift({ ...ev, kind: 'CROSSOVER' });
        rt.status.alerts = rt.status.alerts.slice(0, 20);
        store.logSignal({ index: idx, ...ev, kind: 'CROSSOVER' });
        await notify(ev.name, `${ev.direction === 'UP' ? '🟢 Crossed UP' : '🔴 Crossed DOWN'} — Price ${ev.price.toFixed(1)} vs ${ev.indicatorValue.toFixed(1)}`);
      }
    }
  }
  rt.status.lastUpdate = new Date().toISOString();
}

async function handleStrategyEvent(idx, ev, optionChain) {
  const rt = runtime[idx];
  rt.status.alerts.unshift({ ...ev, kind: 'STRATEGY' });
  rt.status.alerts = rt.status.alerts.slice(0, 20);
  store.logSignal({ index: idx, type: ev.type, direction: ev.direction, at: ev.at, kind: 'STRATEGY' });

  if (ev.type === 'GREEN_DOT') {
    await notify(`${idx} ${ev.direction} — Green Dot`, `Candle closed beyond double EMA. Watching next candle for Gann 0.25 break.`);
  }
  if (ev.type === 'ENTRY') {
    const side = ev.direction === 'CALL' ? 'ce' : 'pe';
    let strikePick = null;
    if (optionChain) strikePick = DhanBroker.findStrikeInPremiumRange(optionChain, side, rt.call.cfg.strikePremiumMin, rt.call.cfg.strikePremiumMax);
    const strikeMsg = strikePick
      ? `Suggested strike: ${strikePick.strike} ${side.toUpperCase()} @ ~${strikePick.leg.last_price}`
      : `No strike found in ₹${rt.call.cfg.strikePremiumMin}-${rt.call.cfg.strikePremiumMax} premium band right now.`;
    rt.status.alerts.unshift({ kind: 'ENTRY_CARD', index: idx, direction: ev.direction, strikePick, targets: ev.targets, at: Date.now() });
    await notify(`🚀 ${idx} ${ev.direction} ENTRY`, strikeMsg);
  }
}

async function notify(title, body) {
  const subs = store.getSubscriptions();
  if (!subs.length) return;
  await broadcast(subs, { title, body, tag: 'index-signal-' + Date.now() });
}

async function pollAll() {
  if (!isMarketHoursNowIST()) return;
  for (const idx of cfg.trackIndices) {
    try { await pollIndex(idx); } catch (e) { console.error(`[${idx}] poll error`, e.message); }
  }
}

// ---------------- boot sequence ----------------
// Bind the HTTP port FIRST, then do slow async setup (scrip-master
// download, broker login, first poll) — this is what actually prevents
// the 502-on-cold-start pattern, since Render's health check hits the
// port almost immediately after deploy.
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));
app.get('/api/health', (req, res) => {
  const perIndex = {};
  for (const idx of cfg.trackIndices) {
    perIndex[idx] = { candleProvider: runtime[idx].status.candleProvider, lastUpdate: runtime[idx].status.lastUpdate };
  }
  res.json({
    ok: true,
    indices: cfg.trackIndices,
    brokerOrder,
    dhan: { configured: dhan.isConfigured(), ...dhan.authStatus() },
    angelOne: { configured: angel.isConfigured() },
    perIndex,
    time: Date.now(),
  });
});

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: cfg.vapid.publicKey }));
app.post('/api/subscribe', requireSecret, (req, res) => { store.addSubscription(req.body); res.json({ ok: true }); });
app.post('/api/unsubscribe', requireSecret, (req, res) => { store.removeSubscription(req.body.endpoint); res.json({ ok: true }); });
app.get('/api/status', requireSecret, (req, res) => {
  const out = {};
  for (const idx of cfg.trackIndices) out[idx] = runtime[idx].status;
  res.json(out);
});
app.get('/api/config/:index', requireSecret, (req, res) => {
  res.json(store.getStrategyConfig(req.params.index.toUpperCase(), cfg.defaultStrategyConfig));
});
app.post('/api/config/:index', requireSecret, (req, res) => {
  const idx = req.params.index.toUpperCase();
  const merged = { ...cfg.defaultStrategyConfig, ...store.getStrategyConfig(idx, {}), ...req.body };
  store.setStrategyConfig(idx, merged);
  if (runtime[idx]) { runtime[idx].call.cfg = merged; runtime[idx].put.cfg = merged; }
  res.json(merged);
});
app.get('/api/signal-log', requireSecret, (req, res) => res.json(store.getSignalLog()));

app.listen(cfg.server.port, () => {
  console.log(`Backend listening on :${cfg.server.port} | tracking ${cfg.trackIndices.join(', ')} | broker order=${brokerOrder.join(' -> ')}`);
  refreshInstruments()
    .then(() => { pollAll(); setInterval(pollAll, cfg.polling.intervalSeconds * 1000); })
    .catch(e => console.error('[boot] instrument resolution failed, will retry on next poll cycle:', e.message));
  setInterval(refreshInstruments, 24 * 60 * 60 * 1000);
  dhan.startAutoRenew(cfg.broker.dhan.renewEveryHours);
});
