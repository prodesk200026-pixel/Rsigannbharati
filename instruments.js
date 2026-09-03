'use strict';
// ============================================================
// instruments.js — resolves NIFTY/BANKNIFTY/SENSEX/FINNIFTY to
// Dhan Security IDs using Dhan's OWN published instrument master,
// refreshed daily, instead of hand-typed numbers that can go stale
// the moment Dhan renumbers anything.
// ============================================================
const axios = require('axios');

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const ONE_DAY = 24 * 60 * 60 * 1000;

let cache = { rows: [], loadedAt: 0 };

function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < headers.length - 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (parts[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

async function ensureLoaded() {
  if (cache.rows.length && (Date.now() - cache.loadedAt) < ONE_DAY) return cache;
  try {
    const res = await axios.get(SCRIP_MASTER_URL, { timeout: 20000 });
    cache = { rows: parseCsv(res.data), loadedAt: Date.now() };
    console.log(`[instruments] loaded ${cache.rows.length} rows from Dhan scrip master`);
  } catch (err) {
    console.error('[instruments] failed to refresh scrip master (serving stale/fallback):', err.message);
  }
  return cache;
}

const INDEX_NAME_MAP = {
  NIFTY: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  SENSEX: 'SENSEX',
  FINNIFTY: 'NIFTY FIN SERVICE',
};

/** Resolve one index name to { securityId, exchangeSegment }. Returns null if not found. */
async function resolveIndex(underlying) {
  const name = underlying.toUpperCase();
  const wanted = INDEX_NAME_MAP[name] || name;
  const { rows } = await ensureLoaded();
  if (!rows.length) return null;
  const exchWanted = name === 'SENSEX' ? 'BSE' : 'NSE';
  const row = rows.find(r => {
    const sym = (r.SEM_CUSTOM_SYMBOL || r.SM_SYMBOL_NAME || r.SYMBOL_NAME || '').toUpperCase();
    const exch = (r.SEM_EXM_EXCH_ID || r.EXCH_ID || '').toUpperCase();
    const instr = (r.SEM_INSTRUMENT_NAME || r.INSTRUMENT_TYPE || '').toUpperCase();
    return sym === wanted && exch.includes(exchWanted) && (instr.includes('INDEX') || instr === '');
  });
  if (!row) return null;
  return {
    securityId: row.SEM_SMST_SECURITY_ID || row.SECURITY_ID,
    exchangeSegment: 'IDX_I',
  };
}

/** Resolve every tracked index at once; falls back to `fallbackMap` per-index on miss. */
async function resolveAll(indexNames, fallbackMap = {}) {
  const out = {};
  for (const name of indexNames) {
    let resolved = null;
    try { resolved = await resolveIndex(name); } catch (e) { /* fall through to fallback */ }
    if (resolved && resolved.securityId) {
      out[name] = resolved;
    } else if (fallbackMap[name]) {
      console.warn(`[instruments] could not resolve ${name} from live scrip master — using fallback securityId ${fallbackMap[name].securityId}`);
      out[name] = fallbackMap[name];
    } else {
      console.error(`[instruments] could not resolve ${name} and no fallback configured — it will be skipped`);
    }
  }
  return out;
}

module.exports = { ensureLoaded, resolveIndex, resolveAll };
