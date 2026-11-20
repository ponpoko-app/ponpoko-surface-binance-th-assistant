import type { MarketState, Pair, RankedPair } from "../model.ts";
import { DAY, fail, inBatches, D } from "./util.ts";
import type { MarketVenue } from "./venue.ts";

const stable = new Set(["USDT", "USDC", "FDUSD", "USDP", "DAI", "TUSD", "USD1", "RLUSD", "USDE", "PYUSD", "BUSD", "GUSD", "USDS"]);
export const strategyVersion = "global_momentum_30d_v1";
export type Candle = [number, string, string, string, string, string, number, ...unknown[]];
export type Candidate = Pair & { candles: Candle[]; volume: string | null };

export function closeWindow(rows: Candle[], serverTime: number, count: number) {
  const end = Math.floor(serverTime / DAY) * DAY;
  const closes = rows.filter(row => row[6] < end).slice(-count);
  if (closes.length !== count || !closes.every((row, i) =>
    row[0] === end - (count - i) * DAY && row[6] === row[0] + DAY - 1 &&
    typeof row[4] === "string" && Number.isFinite(Number(row[4])) && Number(row[4]) > 0)) return null;
  return closes;
}

export function returns(rows: Candle[], serverTime: number) {
  const closes = closeWindow(rows, serverTime, 31);
  return closes ? new D(closes[30][4]).div(closes[0][4]).minus(1) : null;
}

export function rank(candidates: Candidate[], btc: Candle[], serverTime: number) {
  const benchmark = returns(btc, serverTime);
  const measured = candidates.flatMap(({ candles, ...pair }) => {
    const score = returns(candles, serverTime);
    return score === null ? [] : [{ ...pair, score }];
  });
  if (benchmark === null || measured.length < 3) return { ranking: [], btcReturn: benchmark?.toNumber() ?? null };
  measured.sort((a, b) => b.score.cmp(a.score) || new D(b.volume ?? 0).cmp(a.volume ?? 0) || a.symbol.localeCompare(b.symbol, "en"));
  const ranking: RankedPair[] = measured.map((pair, i) => ({
    ...pair, rank: i + 1, score: pair.score.toNumber(), versusBtc: pair.score.minus(benchmark).toNumber()
  }));
  return { ranking, btcReturn: benchmark.toNumber() };
}

export function invalidation(rows: Candle[], serverTime: number, price: string) {
  const candles = closeWindow(rows, serverTime, 60);
  if (!candles) return null;
  const ranges = candles.slice(1).map((row, index) => {
    const high = new D(row[2]), low = new D(row[3]), previous = new D(candles[index][4]);
    return D.max(high.minus(low), high.minus(previous).abs(), low.minus(previous).abs());
  });
  let atr = ranges.slice(0, 14).reduce((sum, value) => sum.plus(value), new D(0)).div(14);
  for (const range of ranges.slice(14)) atr = atr.mul(13).plus(range).div(14);
  const stop = new D(price).minus(atr.mul(2));
  return stop.gt(0) && atr.gt(0) ? stop.toDecimalPlaces(12).toFixed() : null;
}

export function signalDay(now: number) {
  return new Date((Math.floor(now / DAY) - 1) * DAY).toISOString().slice(0, 10);
}

export class Market {
  private state: MarketState = { pairs: [], ranking: [], excluded: [], signalDay: null, btcReturn: null, fetchedAt: null, status: "loading", message: "กำลังอ่านคู่เงินบาท" };
  private running = false;
  private marketDay: string | null = null;
  private marketKey: string | null = null;
  private cache = new Map<string, Candle[]>();
  constructor(private venue: MarketVenue, private now: () => number = Date.now) {}

  snapshot() {
    if (this.state.signalDay && this.state.signalDay !== signalDay(this.now())) {
      return { ...this.state, ranking: [], btcReturn: null, status: this.running ? "loading" as const : "unmeasured" as const,
        message: "รอแท่ง Global ที่ปิดล่าสุด เลือกคู่เองได้" };
    }
    return this.state;
  }

  refresh() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.state = this.state.pairs.length ? { ...this.state, message: "กำลังอัปเดตข้อมูลตลาด" }
      : { ...this.state, status: "loading", message: "กำลังอ่านคู่เงินบาท" };
    void this.load().catch(() => {
      if (this.state.signalDay === signalDay(this.now()) && this.state.ranking.length) {
        this.state = { ...this.state, message: "อัปเดตไม่ได้ชั่วคราว กำลังใช้อันดับวันเดิม" };
      } else {
        this.state = { ...this.state, ranking: [], status: "error", message: "อ่านข้อมูลตลาดไม่ได้ ลองโหลดใหม่หรือเลือกคู่เองเมื่อ Binance TH พร้อม" };
      }
    }).finally(() => { this.running = false; });
    return this.snapshot();
  }

  activeSignal(symbol: string) {
    const state = this.snapshot();
    const row = state.ranking.find(pair => pair.symbol === symbol);
    if (state.status !== "ready" || !row || row.score <= 0 || !state.signalDay) {
      return fail("signal", "คู่นี้ไม่มีสัญญาณบวกจากแท่ง Global ล่าสุด เลือกคู่เองได้");
    }
    return state.signalDay;
  }

  private async load() {
    const pairs = await this.venue.pairs();
    const candidates = pairs.filter(pair => !stable.has(pair.base));
    const key = candidates.map(pair => pair.symbol).sort().join(",");
    const preserve = this.marketKey === key && this.state.signalDay === signalDay(this.now()) && this.state.ranking.length > 0;
    this.state = preserve
      ? { ...this.state, pairs, message: "กำลังอัปเดตข้อมูลตลาด" }
      : { ...this.state, pairs, ranking: [], status: "loading", message: "กำลังจับคู่ข้อมูล Binance Global" };
    const clock = await this.venue.globalTime();
    const day = signalDay(clock);
    if (day !== this.marketDay || this.marketKey !== key) this.cache.clear();
    this.marketDay = day;
    this.marketKey = key;
    const get = async (base: string) => {
      const cached = this.cache.get(base);
      if (cached) return cached;
      const rows = await this.venue.globalCandles(base);
      if (returns(rows, clock) !== null) this.cache.set(base, rows);
      return rows;
    };
    const btc = await get("BTC").catch(() => []);
    const results = await inBatches(candidates, 6, async (pair) => {
      const [candles, volume] = await Promise.all([
        get(pair.base).catch(() => []),
        this.venue.volume(pair.symbol).catch(() => null)
      ]);
      return { ...pair, candles, volume };
    });
    const result = rank(results, btc, clock);
    const excluded = results.filter(item => returns(item.candles, clock) === null)
      .map(item => ({ symbol: item.symbol, reason: "ไม่พบคู่ Global ที่ตรงกันหรือแท่งปิดไม่ครบ 31 วัน" }));
    const ready = result.ranking.length > 0;
    this.state = { pairs, excluded, ...result, signalDay: day, fetchedAt: this.now(),
      status: ready ? "ready" : "unmeasured", message: ready ? "" : "ข้อมูลปิดวันยังไม่พอสำหรับจัดอันดับ เลือกคู่เองได้" };
  }
}
