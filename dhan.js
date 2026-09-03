'use strict';
const axios = require('axios');
const { authenticator } = require('otplib');

class DhanBroker {
  constructor(cfg) {
    this.cfg = cfg.broker.dhan;
    this.accessToken = this.cfg.accessToken || null; // may be pre-set manually
    this.tokenExpiryTime = null;
    this.lastAuthError = null;
    this.lastAuthErrorAt = 0;
  }

  isConfigured() {
    // either a manual token OR client id + pin + totp secret is enough
    return !!(this.cfg.clientId && (this.cfg.accessToken || (this.cfg.pin && this.cfg.totpSecret)));
  }

  authStatus() {
    return {
      hasCredentials: this.isConfigured(),
      hasToken: !!this.accessToken,
      tokenExpiryTime: this.tokenExpiryTime,
      lastAuthError: this.lastAuthError,
      lastAuthErrorAt: this.lastAuthErrorAt || null,
    };
  }

  _trackAuthError(e) {
    const status = e.response && e.response.status;
    if (status === 401 || status === 403) {
      const body = e.response && e.response.data;
      this.lastAuthError = (body && (body.errorMessage || body.remarks)) || 'Dhan auth rejected (token expired or invalid)';
      this.lastAuthErrorAt = Date.now();
    }
  }

  /**
   * Confirmed endpoint (dhanhq.co/docs/v2/authentication):
   *   POST https://auth.dhan.co/app/generateAccessToken?dhanClientId=...&pin=...&totp=...
   * Only works if TOTP is enabled on your Dhan account (Dhan Web -> Profile
   * -> DhanHQ Trading APIs -> enable TOTP once, you'll get the same kind of
   * base32 secret you'd scan into Google Authenticator).
   */
  async login() {
    if (!this.cfg.pin || !this.cfg.totpSecret) throw new Error('Dhan PIN/TOTP secret not configured — set DHAN_PIN and DHAN_TOTP_SECRET, or set DHAN_ACCESS_TOKEN directly instead.');
    const totp = authenticator.generate(this.cfg.totpSecret);
    try {
      const { data } = await axios.post(`${this.cfg.authBaseUrl}/app/generateAccessToken`, {}, {
        params: { dhanClientId: this.cfg.clientId, pin: this.cfg.pin, totp },
        timeout: 10000,
      });
      if (!data || !data.accessToken) throw new Error('Dhan login response missing accessToken: ' + JSON.stringify(data));
      this.accessToken = data.accessToken;
      this.tokenExpiryTime = data.expiryTime || null;
      console.log('[Dhan] TOTP login OK, token valid until', this.tokenExpiryTime);
      return this.accessToken;
    } catch (e) {
      this._trackAuthError(e);
      throw e;
    }
  }

  async ensureToken() {
    if (this.accessToken) return this.accessToken;
    return this.login();
  }

  _headers(token) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'access-token': token,
      'client-id': this.cfg.clientId,
    };
  }

  /** Runs a Dhan v2 API call; on 401 (expired token) re-logs in once and retries. */
  async _call(path, body) {
    let token = await this.ensureToken();
    try {
      const { data } = await axios.post(`${this.cfg.baseUrl}${path}`, body, { headers: this._headers(token), timeout: 10000 });
      return data;
    } catch (e) {
      const status = e.response && e.response.status;
      if ((status === 401 || status === 403) && this.cfg.pin && this.cfg.totpSecret) {
        console.warn('[Dhan] token rejected, re-logging in via TOTP and retrying once...');
        this.accessToken = null;
        token = await this.ensureToken();
        const { data } = await axios.post(`${this.cfg.baseUrl}${path}`, body, { headers: this._headers(token), timeout: 10000 });
        return data;
      }
      this._trackAuthError(e);
      throw e;
    }
  }

  async getIntradayCandles(securityId, exchangeSegment, interval, fromDate, toDate) {
    const data = await this._call('/v2/charts/intraday', {
      securityId: String(securityId), exchangeSegment, instrument: 'INDEX',
      interval: String(interval), oi: false, fromDate, toDate,
    });
    if (!data || !Array.isArray(data.open)) return [];
    const out = [];
    for (let i = 0; i < data.open.length; i++) {
      out.push({ t: data.timestamp[i] * 1000, o: data.open[i], h: data.high[i], l: data.low[i], c: data.close[i] });
    }
    return out;
  }

  async getExpiryList(underlyingScrip, underlyingSeg) {
    const data = await this._call('/v2/optionchain/expirylist', { UnderlyingScrip: Number(underlyingScrip), UnderlyingSeg: underlyingSeg });
    return (data && data.data) || [];
  }

  async getOptionChain(underlyingScrip, underlyingSeg, expiry) {
    const data = await this._call('/v2/optionchain', { UnderlyingScrip: Number(underlyingScrip), UnderlyingSeg: underlyingSeg, Expiry: expiry });
    return (data && data.data) || null;
  }

  static extractAtm(optionChainData) {
    if (!optionChainData || !optionChainData.oc) return null;
    const underlyingPrice = optionChainData.last_price;
    const strikes = Object.keys(optionChainData.oc).map(Number).sort((a, b) => a - b);
    if (!strikes.length) return null;
    let atmStrike = strikes.reduce((best, s) => Math.abs(s - underlyingPrice) < Math.abs(best - underlyingPrice) ? s : best, strikes[0]);
    const row = optionChainData.oc[String(atmStrike)] || optionChainData.oc[atmStrike];
    if (!row) return null;
    const ce = row.ce || {};
    const pe = row.pe || {};
    const straddlePrice = (ce.last_price || 0) + (pe.last_price || 0);
    const atmIv = ((ce.implied_volatility || 0) + (pe.implied_volatility || 0)) / 2;
    return { strike: atmStrike, underlyingPrice, ce, pe, straddlePrice, atmIv };
  }

  static findStrikeInPremiumRange(optionChainData, side, min, max) {
    if (!optionChainData || !optionChainData.oc) return null;
    const rows = Object.entries(optionChainData.oc)
      .map(([strike, row]) => ({ strike: Number(strike), leg: row[side] }))
      .filter(r => r.leg && typeof r.leg.last_price === 'number');
    const inRange = rows.filter(r => r.leg.last_price >= min && r.leg.last_price <= max);
    if (!inRange.length) return null;
    const mid = (min + max) / 2;
    inRange.sort((a, b) => Math.abs(a.leg.last_price - mid) - Math.abs(b.leg.last_price - mid));
    return inRange[0];
  }

  /** Periodic refresh so the token never sits at the edge of expiry. Works
   *  for both auth styles: TOTP re-login, or (if only a manual token was
   *  given) the classic /v2/RenewToken extend-by-24h call. */
  startAutoRenew(everyHours = 20) {
    if (!this.isConfigured()) return;
    setInterval(async () => {
      try {
        if (this.cfg.pin && this.cfg.totpSecret) {
          this.accessToken = null;
          await this.login();
        } else if (this.accessToken) {
          await axios.post(`${this.cfg.baseUrl}/v2/RenewToken`, {}, {
            headers: { 'access-token': this.accessToken, dhanClientId: this.cfg.clientId },
            timeout: 10000,
          });
          console.log('[Dhan] token renewed via RenewToken');
        }
      } catch (e) {
        console.warn('[Dhan] scheduled token refresh failed:', e.message);
      }
    }, everyHours * 60 * 60 * 1000);
  }
}

module.exports = { DhanBroker };
