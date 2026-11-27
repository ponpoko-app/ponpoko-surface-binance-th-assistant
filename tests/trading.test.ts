import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Fill, Order, PreviewRequest } from "../src/model.ts";
import { pilotPair } from "../src/model.ts";
import { Ledger } from "../src/backend/ledger.ts";
import { Market, rank, returns, type Candle } from "../src/backend/market.ts";
import { Trading } from "../src/backend/service.ts";
import { Binance, ExchangeFault, type Book, type Credentials, type MarketVenue, type SymbolInfo, type TradingVenue, type VenueOrder } from "../src/backend/venue.ts";
import { D, DAY } from "../src/backend/util.ts";

const time = Date.parse("2026-11-19T04:00:00Z");
const info: SymbolInfo = {
  symbol: pilotPair, baseAsset: "BTC", quoteAsset: "THB", status: "TRADING", orderTypes: ["LIMIT"],
  filters: [
    { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "10000000", tickSize: "1" },
    { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
    { filterType: "MIN_NOTIONAL", minNotional: "100" }
  ]
};
const clockStart = Math.floor(time / DAY) * DAY;
function candles(last: string, count = 60) {
  return Array.from({ length: count }, (_, i): Candle => {
    const start = clockStart - (count - i) * DAY;
    return [start, "100", "102", "99", i === count - 1 ? last : "100", "1", start + DAY - 1];
  });
}
const seed = { key: "fixture-user-key", secret: "fixture-only", pilot: true };
const liveCaps = { order: "1000", exposure: "1000", planLoss: "100", dailyLoss: "200" };
const buy: PreviewRequest = { mode: "paper", side: "BUY", symbol: pilotPair, approach: "manual",
  price: "500000", invalidation: "470000", budget: "400" };
const sell: PreviewRequest = { mode: "paper", side: "SELL", symbol: pilotPair, approach: "manual", price: "499500" };

test("oversized exchange payloads without a length header are cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const fetcher = Object.assign(async () => new Response(stream), { preconnect: fetch.preconnect });
  const adapter = new Binance(fetcher, () => time);
  await expect(adapter.pairs()).rejects.toMatchObject({ status: 200, definite: false });
  expect(cancelled).toBe(true);
});

class FakeVenue implements MarketVenue, TradingVenue {
  now = time;
  submitted: Order[] = [];
  canceled: Order[] = [];
  checks = 0;
  accountChecks = 0;
  response: VenueOrder | null = null;
  remoteFills: Fill[] = [];
  unknown = false;
  globalDown = false;
  beforeSend = () => {};
  bid = "499500";
  ask = "500000";

  async pairs() { return ["BTC", "ETH", "SOL"].map(base => ({ symbol: base + "THB", base })); }
  async globalTime() {
    if (this.globalDown) throw new Error("Global unavailable");
    return this.now;
  }
  async globalCandles(base: string) { return candles(base === "BTC" ? "109" : base === "ETH" ? "110" : "111"); }
  async volume() { return "3600000"; }
  async info() { return info; }
  async book(): Promise<Book> { return { bids: [[this.bid, "1"]], asks: [[this.ask, "1"]], at: this.now }; }
  async average() { return this.ask; }
  async thCandles() { return candles("100"); }
  async account() { this.accountChecks += 1; return { canTrade: true, free: new Map([["BTC", "1"], ["THB", "10000"]]) }; }
  async fee() { return "0.0025"; }
  async send(_credentials: Credentials, order: Order, start: () => void) {
    this.beforeSend();
    start();
    this.submitted.push(order);
    if (this.unknown || !this.response) throw new ExchangeFault(null, 503, false);
    return this.response;
  }
  async query() {
    this.checks += 1;
    if (!this.response) throw new ExchangeFault(-2013, 400, false);
    return this.response;
  }
  async trades() { return this.remoteFills; }
  async cancel(_credentials: Credentials, order: Order, start: () => void) {
    start();
    this.canceled.push(order);
    return { orderId: order.orderId!, status: "CANCELED" as const, executed: order.filledQuantity };
  }
}

const ledgers: Ledger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });
function setup(key: Credentials | null = seed) {
  const venue = new FakeVenue(), ledger = new Ledger(":memory:");
  ledgers.push(ledger);
  const market = new Market(venue, () => venue.now);
  const trading = new Trading(ledger, venue, market, () => key, () => true, () => venue.now);
  if (key) trading.settings("confirm", liveCaps);
  return { trading, venue, ledger, market };
}

describe("market", () => {
  test("uses equal closed UTC days and excludes a missing day or ambiguous window", () => {
    const open: Candle = [clockStart, "100", "1000", "99", "1000", "1", clockStart + DAY - 1];
    const valid = [...candles("120"), open];
    expect(returns(valid, time)?.toFixed()).toBe("0.2");
    expect(returns(valid.filter(row => row[0] !== clockStart - DAY * 5), time)).toBeNull();
    expect(returns(valid, time + DAY * 2)).toBeNull();
    const result = rank([
      { symbol: "BTCTHB", base: "BTC", volume: "500", candles: candles("108") },
      { symbol: "SOLTHB", base: "SOL", volume: "900", candles: candles("120") },
      { symbol: "ETHTHB", base: "ETH", volume: "1000", candles: valid },
      { symbol: "BADTHB", base: "BAD", volume: "99999", candles: [] }
    ], candles("108"), time);
    expect(result.ranking.map(row => row.symbol)).toEqual(["ETHTHB", "SOLTHB", "BTCTHB"]);
    expect(result.ranking[0].versusBtc).toBe(0.12);
  });

  test("reads exact TH endpoints and never forwards a private key to Global", async () => {
    const requests: { url: URL; options?: RequestInit }[] = [];
    const adapter = new Binance((async (url: URL, options?: RequestInit) => {
      requests.push({ url, options });
      if (url.pathname.endsWith("/time")) return Response.json({ serverTime: time });
      if (url.pathname.endsWith("accountV2")) return Response.json({ canTrade: true, balances: [{ asset: "THB", free: "500" }] });
      return Response.json({ orderId: 123, status: "EXPIRED", executedQty: "0.00015" });
    }) as typeof fetch, () => time);
    await adapter.globalTime();
    const account = await adapter.account(seed);
    expect(account.free.get("THB")).toBe("500");
    let didStart = false;
    const order = { id: "fixture", symbol: pilotPair, side: "BUY", price: "500000", quantity: "0.00035" } as Order;
    const result = await adapter.send(seed, order, () => { didStart = true; });
    expect(result).toEqual({ orderId: "123", status: "EXPIRED", executed: "0.00015" });
    expect(didStart).toBeTrue();
    expect(requests[0].url.host).toBe("data-api.binance.vision");
    expect(new Headers(requests[0].options?.headers).has("X-MBX-APIKEY")).toBeFalse();
    expect(requests.slice(1).every(item => item.url.host === "api.binance.th")).toBeTrue();
    expect(requests.at(-1)?.url.searchParams.get("timeInForce")).toBe("IOC");
    expect(requests.at(-1)?.url.searchParams.get("signature")).toMatch(/^[a-f\d]{64}$/);
  });

  test("keeps the manual TH workflow available when Global is down", async () => {
    const { trading, venue, market } = setup(null);
    venue.globalDown = true;
    market.refresh();
    for (let i = 0; i < 5 && market.snapshot().status !== "error"; i += 1) await Bun.sleep(1);
    expect(market.snapshot().status).toBe("error");
    expect(market.snapshot().pairs).toHaveLength(3);
    expect((await trading.preview(buy)).approach).toBe("manual");
    await expect(trading.preview({ ...buy, approach: "momentum" })).rejects.toMatchObject({ code: "signal" });
  });
});

describe("order workflow", () => {
  test("paper buys and sells with no private requests, keeps cash and dust separate", async () => {
    const { trading, venue } = setup(null);
    const preview = await trading.preview(buy);
    expect(new D(preview.maximumPayment!).lte(400)).toBeTrue();
    const initial = await trading.submit(preview.id);
    expect(initial.status).toBe("FILLED");
    expect(await trading.submit(preview.id)).toEqual(initial);
    const holding = await trading.state("paper");
    expect(holding.position?.symbol).toBe(pilotPair);
    expect(New(holding.cash).lt(10_000)).toBeTrue();
    const sale = await trading.preview(sell);
    await trading.submit(sale.id);
    const result = await trading.state("paper");
    expect(result.position).toBeNull();
    expect(result.dust).toHaveLength(1);
    expect(New(result.net).lt(0)).toBeTrue();
    expect(venue.accountChecks).toBe(0);
    expect(venue.submitted).toHaveLength(0);
  });

  test("lot and notional constraints do not round the order up", async () => {
    const { trading } = setup();
    await expect(trading.preview({ ...buy, budget: "100" })).rejects.toMatchObject({ code: "minimum" });
  });

  test("old, changed and halted tickets cannot send", async () => {
    const { trading, venue } = setup();
    const first = await trading.preview({ ...buy, mode: "confirm" });
    venue.now += 30_001;
    await expect(trading.submit(first.id)).rejects.toMatchObject({ code: "ticket" });
    const second = await trading.preview({ ...buy, mode: "confirm" });
    trading.settings("confirm", { ...liveCaps, planLoss: "95" });
    await expect(trading.submit(second.id)).rejects.toMatchObject({ code: "requote" });
    const third = await trading.preview({ ...buy, mode: "confirm" });
    await trading.halt("confirm");
    await expect(trading.submit(third.id)).rejects.toMatchObject({ code: "halt" });
    expect(venue.submitted).toHaveLength(0);
  });

  test("re-checks halt at actual dispatch boundary", async () => {
    const { trading, venue, ledger } = setup();
    const ticket = await trading.preview({ ...buy, mode: "confirm" });
    venue.beforeSend = () => ledger.halt("confirm", true, venue.now);
    await expect(trading.submit(ticket.id)).rejects.toMatchObject({ code: "ticket" });
    expect(venue.submitted).toHaveLength(0);
  });

  test("timeout stays unresolved until original IOC partial fill is verified", async () => {
    const { trading, venue } = setup();
    venue.unknown = true;
    const ticket = await trading.preview({ ...buy, mode: "confirm" });
    const results = await Promise.allSettled([trading.submit(ticket.id), trading.submit(ticket.id)]);
    expect(results.some(result => result.status === "fulfilled" && result.value.status === "unknown_outcome")).toBeTrue();
    expect(venue.submitted).toHaveLength(1);
    expect((await trading.submit(ticket.id)).status).toBe("unknown_outcome");
    await expect(trading.preview({ ...buy, mode: "confirm" })).rejects.toMatchObject({ code: "pending" });
    const unresolved = await trading.reconcile(ticket.id);
    expect(unresolved.status).toBe("unknown_outcome");
    expect(venue.checks).toBe(3);
    venue.response = { orderId: "7101", status: "EXPIRED", executed: "0.0005" };
    const fill = { id: "11", price: "500000", quantity: "0.0005", quote: "250", fee: "0.00000125", feeAsset: "BTC", at: time };
    venue.remoteFills = [fill, fill];
    expect((await trading.reconcile(ticket.id)).accounted).toBeTrue();
    const state = await trading.state("confirm");
    expect(state.openUnknown).toBeFalse();
    expect(state.position?.quantity).toBe("0.00049875");
    expect(venue.submitted).toHaveLength(1);
  });

  test("halts only a known open entry and leaves an ordinary exit available", async () => {
    const { trading, venue } = setup();
    venue.response = { orderId: "7101", status: "NEW", executed: "0" };
    const ticket = await trading.preview({ ...buy, mode: "confirm" });
    expect((await trading.submit(ticket.id)).status).toBe("NEW");
    await trading.halt("confirm");
    expect(venue.canceled.map(order => order.id)).toEqual([ticket.id]);
    await trading.halt("confirm");
    expect(venue.canceled).toHaveLength(1);
    const paper = await trading.preview(buy);
    await trading.submit(paper.id);
    await trading.halt("paper");
    expect((await trading.preview(sell)).side).toBe("SELL");
  });

  test("a read-only key cannot prepare a live ticket", async () => {
    const { trading, venue } = setup({ ...seed, pilot: false });
    expect((await trading.state("confirm")).live).toBe("read_only");
    await expect(trading.preview({ ...buy, mode: "confirm" })).rejects.toMatchObject({ code: "live" });
    expect(venue.submitted).toHaveLength(0);
  });

  test("opening a ledger with an unresolved submission never replays it", async () => {
    mkdirSync(".qa", { recursive: true });
    const directory = mkdtempSync(join(".qa", "ledger-test-"));
    const path = join(directory, "ledger.sqlite3");
    const venue = new FakeVenue();
    const market = new Market(venue, () => venue.now);
    let stored = new Ledger(path);
    try {
      const first = new Trading(stored, venue, market, () => seed, () => true, () => time);
      first.settings("confirm", liveCaps);
      const ticket = await first.preview({ ...buy, mode: "confirm" });
      expect((await first.submit(ticket.id)).status).toBe("unknown_outcome");
      stored.close();
      stored = new Ledger(path);
      const next = new Trading(stored, venue, market, () => seed, () => true, () => time);
      expect((await next.state("confirm")).openUnknown).toBeTrue();
      expect(venue.checks).toBe(0);
      expect((await next.submit(ticket.id)).status).toBe("unknown_outcome");
      expect(venue.submitted).toHaveLength(1);
    } finally {
      stored.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function New(value: string | null) { return new D(value ?? "NaN"); }
