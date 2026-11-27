import { createHmac } from "node:crypto";
import type { Fill, Order, OrderStatus, Pair } from "../model.ts";
import { pairPattern } from "../model.ts";
import type { Candle } from "./market.ts";
import { amount, fail, Fault, positive } from "./util.ts";

const TH = "https://api.binance.th";
const GLOBAL = "https://data-api.binance.vision";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const rejectedCodes = new Set([-1013, -1015, -1021, -1022, -1100, -1102, -1111, -1121, -2010, -2014, -2015]);
const orderStates = new Set<OrderStatus>(["NEW", "PARTIALLY_FILLED", "FILLED", "EXPIRED", "CANCELED", "REJECTED"]);

export type Credentials = { key: string; secret: string; pilot: boolean };
export type Account = { canTrade: boolean; free: Map<string, string> };
export type Rule = { filterType: string; [key: string]: unknown };
export type SymbolInfo = {
  symbol: string; baseAsset: string; quoteAsset: string; status: string;
  filters: Rule[]; orderTypes: string[]; isSpotTradingAllowed?: boolean;
};
export type Book = { bids: [string, string][]; asks: [string, string][]; at: number };
export type VenueOrder = { orderId: string; status: OrderStatus; executed: string };

export interface MarketVenue {
  pairs(): Promise<Pair[]>;
  globalTime(): Promise<number>;
  globalCandles(base: string): Promise<Candle[]>;
  volume(symbol: string): Promise<string>;
}
export interface TradingVenue {
  info(symbol: string): Promise<SymbolInfo>;
  book(symbol: string): Promise<Book>;
  average(symbol: string, minutes: number): Promise<string>;
  thCandles(symbol: string): Promise<Candle[]>;
  account(credentials: Credentials): Promise<Account>;
  fee(credentials: Credentials, symbol: string): Promise<string>;
  send(credentials: Credentials, order: Order, start: () => void): Promise<VenueOrder>;
  query(credentials: Credentials, order: Order): Promise<VenueOrder>;
  trades(credentials: Credentials, order: Order): Promise<Fill[]>;
  cancel(credentials: Credentials, order: Order, start: () => void): Promise<VenueOrder>;
}

export class ExchangeFault extends Fault {
  constructor(readonly exchangeCode: number | null, readonly status: number, readonly definite: boolean) {
    super("venue", definite ? "Binance TH ปฏิเสธคำสั่ง โปรดตรวจราคา จำนวน และสิทธิ์ของ key" : "ติดต่อ exchange ไม่สำเร็จหรือยังยืนยันผลไม่ได้");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing exchange response");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body.cancel().catch(() => {});
    throw new Error("Exchange response exceeds its limit");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Exchange response exceeds its limit");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(chunks.join(""));
}

function orderResponse(data: Record<string, unknown>): VenueOrder {
  const status = data.status === "EXPIRED_IN_MATCH" ? "EXPIRED" : data.status as OrderStatus;
  if (!orderStates.has(status) || !/^\d+$/.test(String(data.orderId))) fail("venue_payload", "คำตอบสถานะจาก Binance TH ไม่ครบ");
  return { orderId: String(data.orderId), status, executed: amount(data.executedQty).toFixed() };
}

export class Binance implements MarketVenue, TradingVenue {
  private limitUntil = new Map<string, number>();
  private metadata: { at: number; symbols: SymbolInfo[] } | null = null;
  private timeOffset: { at: number; offset: number } | null = null;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly clock: () => number = Date.now) {}

  private async call<T>(host: string, path: string, values: Record<string, string> = {},
    method = "GET", credentials?: Credentials, start?: () => void): Promise<T> {
    if (host !== TH && credentials) fail("venue_scope", "ส่ง key ได้เฉพาะ Binance TH");
    if ((this.limitUntil.get(host) ?? 0) > this.clock()) fail("rate_limit", "exchange ขอให้รอก่อนลองตรวจข้อมูลอีกครั้ง");
    const search = new URLSearchParams(values);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (credentials) {
      const timestamp = await this.signedTime();
      search.set("timestamp", String(timestamp));
      search.set("recvWindow", "5000");
      search.set("signature", createHmac("sha256", credentials.secret).update(search.toString()).digest("hex"));
      headers["X-MBX-APIKEY"] = credentials.key;
    }
    const url = new URL(path, host);
    url.search = search.toString();
    let response: Response;
    start?.();
    try {
      response = await this.fetcher(url, { method, headers, redirect: "error", signal: AbortSignal.timeout(4_500) });
    } catch { throw new ExchangeFault(null, 0, false); }
    if (response.status === 429 || response.status === 418) {
      const retry = response.headers.get("retry-after");
      const parsed = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.clock() : NaN;
      const delay = Number.isFinite(parsed) ? Math.max(1_000, parsed) : response.status === 418 ? 120_000 : 15_000;
      this.limitUntil.set(host, this.clock() + delay);
    }
    let data: unknown;
    try { data = await boundedJson(response); } catch { throw new ExchangeFault(null, response.status, false); }
    const code = data && typeof data === "object" && "code" in data ? Number(data.code) : null;
    if (!response.ok || (code !== null && code < 0)) {
      throw new ExchangeFault(code, response.status, response.status >= 400 && response.status < 418 && code !== null && rejectedCodes.has(code));
    }
    return data as T;
  }

  private async signedTime() {
    const start = this.clock();
    if (!this.timeOffset || start - this.timeOffset.at > 20_000) {
      const { serverTime } = await this.call<{ serverTime: number }>(TH, "/api/v1/time");
      const end = this.clock();
      if (!Number.isSafeInteger(serverTime) || end - start > 2_000) fail("time", "เวลา exchange ยังไม่พร้อมสำหรับคำสั่งจริง");
      this.timeOffset = { at: end, offset: serverTime - Math.round((start + end) / 2) };
    }
    return this.clock() + this.timeOffset.offset;
  }

  private async symbols(fresh = false) {
    if (fresh || !this.metadata || this.clock() - this.metadata.at > 120_000) {
      const result = await this.call<{ symbols: SymbolInfo[] }>(TH, "/api/v1/exchangeInfo");
      if (!Array.isArray(result.symbols)) fail("market", "อ่านคู่เงิน Binance TH ไม่ได้");
      this.metadata = { at: this.clock(), symbols: result.symbols };
    }
    return this.metadata.symbols;
  }

  async pairs() {
    return (await this.symbols()).filter(row => row.status === "TRADING" && row.quoteAsset === "THB" &&
      row.symbol === row.baseAsset + "THB" && pairPattern.test(row.symbol) && row.isSpotTradingAllowed !== false)
      .map(row => ({ symbol: row.symbol, base: row.baseAsset }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol, "en"));
  }

  async info(symbol: string) {
    const { symbols } = await this.call<{ symbols: SymbolInfo[] }>(TH, "/api/v1/exchangeInfo", { symbol });
    const info = symbols.find(row => row.symbol === symbol && row.status === "TRADING" &&
      row.quoteAsset === "THB" && row.symbol === row.baseAsset + "THB" && row.isSpotTradingAllowed !== false);
    if (!info || !info.orderTypes.includes("LIMIT")) fail("symbol", "คู่นี้ไม่พร้อมส่งคำสั่ง Limit ที่ Binance TH");
    return info;
  }

  async globalTime() {
    const { serverTime } = await this.call<{ serverTime: number }>(GLOBAL, "/api/v3/time");
    if (!Number.isSafeInteger(serverTime) || Math.abs(this.clock() - serverTime) > 300_000) fail("time", "ยืนยันเวลาของ Binance Global ไม่ได้");
    return serverTime;
  }

  async globalCandles(base: string) {
    const symbol = base + "USDT";
    const { symbols } = await this.call<{ symbols: SymbolInfo[] }>(GLOBAL, "/api/v3/exchangeInfo", { symbol, showPermissionSets: "false" });
    if (!symbols.some(row => row.symbol === symbol && row.baseAsset === base && row.quoteAsset === "USDT" &&
      row.status === "TRADING" && row.isSpotTradingAllowed === true)) return [];
    return this.call<Candle[]>(GLOBAL, "/api/v3/klines", { symbol, interval: "1d", limit: "32" });
  }

  async volume(symbol: string) {
    const data = await this.call<{ quoteVolume: string }>(TH, "/api/v1/ticker/24hr", { symbol });
    return amount(data.quoteVolume).toFixed();
  }

  thCandles(symbol: string) {
    return this.call<Candle[]>(TH, "/api/v1/klines", { symbol, interval: "1d", limit: "61" });
  }

  async book(symbol: string): Promise<Book> {
    const at = this.clock();
    const data = await this.call<Omit<Book, "at">>(TH, "/api/v1/depth", { symbol, limit: "20" });
    if (!Array.isArray(data.bids) || !Array.isArray(data.asks) || !data.bids.length || !data.asks.length) {
      fail("book", "สมุดคำสั่งยังไม่มีราคาซื้อและขายครบ");
    }
    for (const [price, quantity] of [...data.bids, ...data.asks]) { positive(price); positive(quantity); }
    if (amount(data.bids[0][0]).gte(data.asks[0][0])) fail("book", "ราคาจากสมุดคำสั่งไม่สอดคล้องกัน");
    return { bids: data.bids, asks: data.asks, at };
  }

  async average(symbol: string, minutes: number) {
    const now = this.clock();
    const rows = await this.call<{ price: string; qty: string; time: number }[]>(TH, "/api/v1/trades", {
      symbol, limit: minutes ? "1000" : "1"
    });
    if (!Array.isArray(rows) || !rows.length) fail("price_band", "ยังตรวจกรอบราคาจากประวัติซื้อขายไม่ได้");
    if (!minutes) return positive(rows.at(-1)?.price).toFixed();
    const cutoff = now - minutes * 60_000;
    if (rows.length >= 1000 && rows[0].time > cutoff) fail("price_band", "ช่วงข้อมูลไม่ครบสำหรับตรวจกรอบราคา");
    const last = rows.filter(row => row.time >= cutoff && row.time <= now + 1_000);
    if (!last.length) return positive(rows.at(-1)?.price).toFixed();
    const first = positive(last[0].qty);
    let qty = first, value = first.mul(positive(last[0].price));
    for (const row of last.slice(1)) { const size = positive(row.qty); qty = qty.plus(size); value = value.plus(size.mul(positive(row.price))); }
    return value.div(qty).toDecimalPlaces(18).toFixed();
  }

  async account(credentials: Credentials) {
    const data = await this.call<{ canTrade?: boolean; balances: { asset: string; free: string }[] }>(TH, "/api/v1/accountV2", {}, "GET", credentials);
    if (!Array.isArray(data.balances)) fail("account", "Binance TH ไม่คืนยอดบัญชีที่ใช้ตรวจสอบได้");
    return { canTrade: data.canTrade === true, free: new Map(data.balances.map(row => [row.asset, amount(row.free).toFixed()])) };
  }

  async fee(credentials: Credentials, symbol: string) {
    const data = await this.call<{ symbol: string; takerCommission: string }[]>(TH, "/api/v1/asset/tradeFee", { symbol }, "GET", credentials);
    const fee = Array.isArray(data) && data.find(row => row.symbol === symbol);
    if (!fee) fail("fee", "ยังอ่านค่าธรรมเนียมจริงของคู่นี้ไม่ได้");
    const rate = amount(fee.takerCommission);
    if (rate.gte(1)) fail("fee", "ค่าธรรมเนียมที่ Binance TH ส่งมาอยู่นอกช่วงที่รองรับ");
    return rate.toFixed();
  }

  async send(credentials: Credentials, order: Order, start: () => void) {
    const data = await this.call<Record<string, unknown>>(TH, "/api/v1/order", {
      symbol: order.symbol, side: order.side, type: "LIMIT", timeInForce: "IOC",
      price: order.price, quantity: order.quantity, newClientOrderId: order.id, newOrderRespType: "RESULT"
    }, "POST", credentials, start);
    return orderResponse(data);
  }

  async query(credentials: Credentials, order: Order) {
    const data = await this.call<Record<string, unknown>>(TH, "/api/v1/order", { symbol: order.symbol, origClientOrderId: order.id }, "GET", credentials);
    return orderResponse(data);
  }

  async trades(credentials: Credentials, order: Order) {
    if (!order.orderId) return [];
    const rows = await this.call<Record<string, unknown>[]>(TH, "/api/v1/userTrades", {
      symbol: order.symbol, orderId: order.orderId, limit: "1000"
    }, "GET", credentials);
    return rows.filter(row => String(row.orderId) === order.orderId).map(row => {
      if (!/^\d+$/.test(String(row.id)) || typeof row.commissionAsset !== "string" ||
        typeof row.time !== "number" || !Number.isSafeInteger(row.time)) fail("venue_payload", "ข้อมูล fill ไม่ครบ");
      const quantity = positive(row.qty), price = positive(row.price);
      return { id: String(row.id), price: price.toFixed(), quantity: quantity.toFixed(),
        quote: row.quoteQty == null ? quantity.mul(price).toFixed() : positive(row.quoteQty).toFixed(),
        fee: amount(row.commission).toFixed(), feeAsset: row.commissionAsset, at: row.time };
    });
  }

  async cancel(credentials: Credentials, order: Order, start: () => void) {
    const data = await this.call<Record<string, unknown>>(TH, "/api/v1/order", { symbol: order.symbol, origClientOrderId: order.id }, "DELETE", credentials, start);
    return orderResponse(data);
  }
}
