'use strict';
const axios = require('axios');
const { authenticator } = require('otplib');

// Angel One does NOT publish a ready-made option-chain endpoint. The
// standard workaround (used across the whole SmartAPI community — see
// the SmartAPI forum) is: download the daily Scrip/Instrument master,
// filter it for the option symbols you need, then call the quote/LTP
// endpoint for those specific tokens. That's what this adapter does.
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

class AngelOneBroker {
  constructor(cfg) {
    this.cfg = cfg.broker.angel;
    this.client = axios.create({ baseURL: this.cfg.baseUrl, timeout: 10000 });
    this.jwt = null;
    this.scripMasterCache = null;
    this.scripMasterCachedAt = 0;
  }

  isConfigured() {
    return !!(this.cfg.apiKey && this.cfg.clientCode && this.cfg.password && this.cfg.totpSecret);
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': this.cfg.apiKey,
    };
  }

  async login() {
    const totp = authenticator.generate(this.cfg.totpSecret);
    const { data } = await this.client.post(
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: this.cfg.clientCode, password: this.cfg.password, totp },
      { headers: { 'Content-Type': 'application/json', 'X-PrivateKey': this.cfg.apiKey, 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00' } }
    );
    if (!data || !data.data || !data.data.jwtToken) throw new Error('Angel One login failed: ' + JSON.stringify(data));
    this.jwt = data.data.jwtToken;
    return this.jwt;
  }

  async ensureLogin() {
    if (!this.jwt) await this.login();
  }

  async getScripMaster() {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (this.scripMasterCache && Date.now() - this.scripMasterCachedAt < ONE_DAY) return this.scripMasterCache;
    const { data } = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    this.scripMasterCache = data;
    this.scripMasterCachedAt = Date.now();
    return data;
  }

  /** interval e.g. 'THREE_MINUTE'; from/to format 'YYYY-MM-DD HH:mm' */
  async getCandles(symbolToken, exchange, interval, fromDate, toDate) {
    await this.ensureLogin();
    const { data } = await this.client.post(
      '/rest/secure/angelbroking/historical/v1/getCandleData',
      { exchange, symboltoken: symbolToken, interval, fromdate: fromDate, todate: toDate },
      { headers: this.authHeaders() }
    );
    if (!data || !Array.isArray(data.data)) return [];
    return data.data.map(row => ({ t: new Date(row[0]).getTime(), o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }));
  }

  static minutesToInterval(mins) {
    const map = { 1: 'ONE_MINUTE', 3: 'THREE_MINUTE', 5: 'FIVE_MINUTE', 10: 'TEN_MINUTE', 15: 'FIFTEEN_MINUTE', 30: 'THIRTY_MINUTE', 60: 'ONE_HOUR' };
    return map[mins] || 'THREE_MINUTE';
  }

  /** meta = the `angel: { token, exchange }` block from config.indexMap[idx] */
  async getIndexCandles(meta, candleTimeframeMinutes, fromDate, toDate) {
    const interval = AngelOneBroker.minutesToInterval(candleTimeframeMinutes);
    return this.getCandles(meta.token, meta.exchange, interval, fromDate, toDate);
  }

  async getLtp(exchange, tradingSymbol, symbolToken) {
    await this.ensureLogin();
    const { data } = await this.client.post(
      '/rest/secure/angelbroking/order/v1/getLtpData',
      { exchange, tradingsymbol: tradingSymbol, symboltoken: symbolToken },
      { headers: this.authHeaders() }
    );
    return data && data.data ? data.data : null;
  }

  /** Find option instruments for `name` (NIFTY/BANKNIFTY/SENSEX/FINNIFTY) nearest `expiry` (DDMMMYYYY, e.g. 25SEP26). */
  async findOptionInstruments(name, expiry) {
    const master = await this.getScripMaster();
    return master.filter(row =>
      row.name === name &&
      row.expiry === expiry &&
      (row.symbol.endsWith('CE') || row.symbol.endsWith('PE'))
    );
  }
}

module.exports = { AngelOneBroker };
