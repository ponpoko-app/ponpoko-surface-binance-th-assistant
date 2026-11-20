import type { Mode, Order, PreviewRequest, Quote, Side, Ticket, TradeState } from "../model.ts";
import { pairPattern, pilotPair } from "../model.ts";
import { Ledger, type Review } from "./ledger.ts";
import { Market, invalidation, strategyVersion } from "./market.ts";
import { checkBands, depth, fillSum, needsReview, orderNumbers, pairRules, paperFee, parseCaps, simulatedFills, spread } from "./rules.ts";
import { amount, D, DAY, fail, Fault, hash, object, positive, type Dec } from "./util.ts";
import { type Account, type Book, type Credentials, ExchangeFault, type TradingVenue, type VenueOrder } from "./venue.ts";

const ticketLife = 30_000;
const quoteLife = 5_000;

export function modeOf(value: unknown): Mode {
  if (value === "paper" || value === "confirm") return value;
  return fail("mode", "เลือกเงินจำลองหรือเงินจริงก่อน");
}
export function symbolOf(value: unknown) {
  if (typeof value !== "string" || !pairPattern.test(value)) return fail("symbol", "เลือกคู่เงินบาทที่รองรับ");
  return value;
}
function sideOf(value: unknown): Side {
  if (value === "BUY" || value === "SELL") return value;
  return fail("side", "เลือกซื้อหรือขาย");
}
function optional(value: unknown) { return value === undefined || value === "" ? undefined : positive(value).toFixed(); }
export function readPreview(value: Record<string, unknown>): PreviewRequest {
  if (value.approach !== "manual" && value.approach !== "momentum") return fail("approach", "เลือกแผนจากอันดับหรือเลือกคู่เอง");
  return { mode: modeOf(value.mode), symbol: symbolOf(value.symbol), side: sideOf(value.side), approach: value.approach,
    price: optional(value.price), budget: optional(value.budget), invalidation: optional(value.invalidation) };
}
function cleanOrder(order: Order) {
  const { id, mode, symbol, base, side, price, quantity, invalidation, status, orderId, filledQuantity, accounted, fills, createdAt, message } = order;
  return { id, mode, symbol, base, side, price, quantity, invalidation, status, orderId, filledQuantity, accounted, fills, createdAt, message };
}

type Check = { review: Review; book: Book; credentials: Credentials | null };

export class Trading {
  constructor(private ledger: Ledger, private venue: TradingVenue, private market: Market,
    private vault: () => Credentials | null, private writer: () => boolean, private now: () => number = Date.now) {}

  private requireWriter() {
    if (!this.writer()) fail("writer", "อีกหน้าต่างกำลังควบคุมการส่งคำสั่ง ปิดหน้าต่างนั้นก่อนแล้วลองใหม่");
  }

  private key(requirePilot = false) {
    const credentials = this.vault();
    if (!credentials || (requirePilot && !credentials.pilot)) fail("live", "ยังไม่เปิด pilot เงินจริง ดูวิธีเชื่อมบัญชีในคู่มือ");
    this.ledger.checkAccount(hash(credentials.key));
    return credentials;
  }

  async quote(symbol: string, signal = false): Promise<Quote> {
    const [info, book, candles] = await Promise.all([this.venue.info(symbol), this.venue.book(symbol),
      signal ? this.venue.thCandles(symbol).catch(() => []) : Promise.resolve([])]);
    const rules = pairRules(info);
    return {
      symbol, base: info.baseAsset, bid: book.bids[0][0], ask: book.asks[0][0], spread: spread(book).toFixed(),
      at: book.at, suggestedInvalidation: signal ? invalidation(candles, this.now(), book.asks[0][0]) : null,
      minNotional: rules.minNotional.toFixed(), step: rules.step.toFixed()
    };
  }

  private async check(request: PreviewRequest, id: string, deadline = this.now() + ticketLife): Promise<Check> {
    const { mode, side, symbol, approach } = request;
    const config = this.ledger.config(mode);
    if (!config.caps) fail("caps", "ตั้งเพดานเงินบาทก่อนใช้เงินจริง");
    if (side === "BUY" && config.halted) fail("halt", "หยุดเปิดไม้ใหม่อยู่");
    if (this.ledger.orders(mode).some(needsReview)) fail("pending", "ตรวจผลคำสั่งเดิมก่อนส่งรายการใหม่");
    const position = this.ledger.position(mode);
    if (side === "BUY" && position) fail("position", "มีสถานะที่ surface ดูแลอยู่แล้ว");
    if (side === "SELL" && position?.symbol !== symbol) fail("position", "ขายได้เฉพาะคู่ที่ surface เปิดไว้");
    const signal = side === "BUY" && approach === "momentum" ? this.market.activeSignal(symbol) : null;
    if (mode === "confirm" && symbol !== pilotPair) fail("pair_pilot", "pilot เงินจริงรองรับ BTCTHB เท่านั้น");

    const credentials = mode === "confirm" ? this.key(true) : null;
    const [info, rawFee, account, candles] = await Promise.all([
      this.venue.info(symbol),
      credentials ? this.venue.fee(credentials, symbol) : Promise.resolve(paperFee),
      credentials ? this.venue.account(credentials) : Promise.resolve(null),
      signal ? this.venue.thCandles(symbol).catch(() => []) : Promise.resolve([])
    ]);
    if (account && !account.canTrade) fail("account", "Binance TH ยังไม่ยืนยันว่าบัญชีพร้อมเทรด");
    const fee = amount(rawFee);
    const rules = pairRules(info);
    if (credentials && !rules.liveSupported) fail("rules", "คู่นี้มีตัวกรองคำสั่งที่ pilot ยังไม่รองรับ");
    const book = await this.venue.book(symbol);
    if (side === "BUY" && spread(book).gt("0.005")) fail("spread", "ส่วนต่างราคาซื้อขายเกิน 0.5% สำหรับเปิดไม้ใหม่");
    const reference = side === "BUY" ? book.asks[0][0] : book.bids[0][0];
    const price = request.price ?? reference;
    if (positive(price).minus(reference).abs().div(reference).gt("0.015")) fail("price_move", "ราคา limit ต่างจากราคาอ้างอิงล่าสุดเกิน 1.5% โปรดตรวจราคาใหม่");
    const exit = signal ? invalidation(candles, this.now(), price) : request.invalidation;
    if (side === "BUY" && !exit) fail("invalidation", signal ? "คำนวณจุดทบทวนจากแท่ง TH ไม่ได้ เลือกคู่เองหรือรอข้อมูล" : "กรอกจุดทบทวนแผนก่อนซื้อ");

    const daily = this.ledger.metrics(mode, this.now(), new Map(), true).daily;
    if (side === "BUY" && daily !== null && daily.lte(new D(config.caps.dailyLoss).neg())) {
      this.ledger.halt(mode, true, this.now(), true);
      fail("daily", "ชนเพดานขาดทุนต่อวันแล้ว");
    }
    const free = account
      ? amount(account.free.get(side === "BUY" ? "THB" : info.baseAsset) ?? "0")
      : side === "BUY" ? this.ledger.funds(mode) : amount(position?.quantity ?? "0");
    const values = orderNumbers({
      side, price, budget: request.budget, invalidation: exit ?? undefined, fee, free, caps: config.caps, daily,
      exposure: amount(position?.cost ?? "0"), owned: amount(position?.quantity ?? "0"), rules
    });
    if (credentials) await checkBands(rules, side, positive(values.price), minutes => this.venue.average(symbol, minutes));
    if (this.now() - book.at > quoteLife || this.now() >= deadline) fail("stale", "ข้อมูลราคาหรือใบยืนยันหมดอายุ โปรดตรวจใหม่");
    const expected = depth(book, side, positive(values.price), positive(values.quantity));
    if (side === "BUY" && expected.quantity.lt(values.quantity)) fail("depth", "ราคา limit นี้มีปริมาณเสนอขายไม่พอสำหรับขนาดที่ขอ");
    if (side === "SELL" && expected.quantity.isZero()) fail("depth", "ไม่มีราคาเสนอซื้อที่ถึง limit นี้ โปรดตรวจราคาใหม่");
    const ticket: Ticket = {
      ...values, id, side, mode, symbol, base: info.baseAsset, at: book.at, expiresAt: deadline,
      estimatedFill: expected.quantity.toFixed(), signalDay: signal, approach
    };
    const lockKey = hash(JSON.stringify([mode, side, symbol, ticket.base, values, signal, strategyVersion, config.revision,
      credentials && hash(credentials.key), rules.tick.toFixed(), rules.step.toFixed()]));
    return { review: { ticket, request, lockKey, revision: config.revision, step: rules.step.toFixed() }, book, credentials };
  }

  async preview(request: PreviewRequest): Promise<Ticket> {
    this.requireWriter();
    const { review } = await this.check(request, this.ledger.ticketId());
    this.ledger.saveTicket(review, this.now());
    return review.ticket;
  }

  async submit(id: string): Promise<Order> {
    this.requireWriter();
    const old = this.ledger.getOrder(id);
    if (old) return cleanOrder(old);
    const saved = this.ledger.ticket(id);
    if (!saved || saved.ticket.expiresAt <= this.now()) fail("ticket", "ใบยืนยันหมดอายุ โปรดตรวจใหม่");
    const checked = await this.check(saved.request, id, saved.ticket.expiresAt);
    const { review, book, credentials } = checked;
    const repeated = this.ledger.getOrder(id);
    if (repeated) return cleanOrder(repeated);
    if (saved.lockKey !== review.lockKey) fail("requote", "ราคา จำนวน หรือความเสี่ยงเปลี่ยน โปรดเปิดใบยืนยันใหม่");
    const { mode, side, symbol, base, price, quantity, invalidation } = review.ticket;
    const order = { id, mode, side, symbol, base, price, quantity, invalidation, step: review.step,
      status: "dispatching" as const, orderId: null, filledQuantity: "0", fills: [], accounted: false, createdAt: this.now() };
    let dispatched = false;
    const start = () => {
      if (this.now() - book.at > quoteLife) fail("stale", "ข้อมูลราคาหมดอายุก่อนส่ง");
      if (credentials) this.ledger.bindAccount(hash(credentials.key), this.now());
      this.ledger.consume(review, order, this.now());
      dispatched = true;
    };
    if (!credentials) {
      start();
      const fills = simulatedFills(review.ticket, book, this.now());
      const filled = fillSum(fills);
      return cleanOrder(this.ledger.merge({ ...order, filledQuantity: filled.toFixed(), fills, accounted: true,
        status: filled.eq(quantity) ? "FILLED" : "EXPIRED" }, this.now()));
    }
    try {
      const response = await this.venue.send(credentials, order, start);
      return cleanOrder(await this.applyVenue(order, credentials, response));
    } catch (error) {
      if (!dispatched) {
        const current = this.ledger.getOrder(id);
        if (current) return cleanOrder(current);
        throw error;
      }
      const rejected = error instanceof ExchangeFault && error.definite;
      return cleanOrder(this.ledger.merge({ ...order, status: rejected ? "REJECTED" : "unknown_outcome", accounted: rejected,
        message: rejected ? error.message : "ยังไม่ทราบผลที่ Binance TH กดตรวจคำสั่งเดิม ห้ามส่งซ้ำ" }, this.now()));
    }
  }

  private async applyVenue(order: NonNullable<ReturnType<Ledger["getOrder"]>>, credentials: Credentials, response: VenueOrder) {
    if (amount(response.executed).gt(order.quantity)) fail("fill", "ยอดที่จับคู่เกินยอดเดิม");
    let updated = this.ledger.merge({ ...order, orderId: response.orderId, status: response.status,
      filledQuantity: response.executed, accounted: amount(response.executed).isZero(), message: undefined }, this.now());
    if (updated.accounted) return updated;
    try {
      const rows = await this.venue.trades(credentials, updated);
      const fills = [...new Map(rows.map(fill => [fill.id, fill])).values()];
      const accounted = fillSum(fills).eq(updated.filledQuantity);
      updated = this.ledger.merge({ ...updated, fills: accounted ? fills : updated.fills, accounted,
        message: accounted ? undefined : "รอข้อมูลค่าธรรมเนียมและยอดจับคู่จาก Binance TH" }, this.now());
    } catch {
      updated = this.ledger.merge({ ...updated, message: "ยังอ่านรายการที่จับคู่จาก Binance TH ไม่ได้" }, this.now());
    }
    return updated;
  }

  async reconcile(id: string) {
    this.requireWriter();
    const order = this.ledger.getOrder(id);
    if (!order) fail("order", "ไม่พบคำสั่งเดิม");
    if (order.mode === "paper" || !needsReview(order)) return cleanOrder(order);
    const credentials = this.key();
    const until = this.now() + 16_000;
    for (let attempt = 0; attempt < 3 && this.now() < until; attempt += 1) {
      try {
        const checked = await this.applyVenue(order, credentials, await this.venue.query(credentials, order));
        if (!needsReview(checked) || checked.status === "NEW" || checked.status === "PARTIALLY_FILLED") return cleanOrder(checked);
      } catch (error) {
        if (error instanceof Fault && error.code === "rate_limit") break;
      }
      if (attempt < 2) await Bun.sleep(350 * (attempt + 1));
    }
    return cleanOrder(this.ledger.getOrder(id) ?? order);
  }

  settings(mode: Mode, values: unknown) {
    this.requireWriter();
    if (mode === "confirm") this.key();
    this.ledger.saveCaps(mode, parseCaps(object(values)), this.now());
  }

  async halt(mode: Mode) {
    this.requireWriter();
    this.ledger.halt(mode, true, this.now());
    if (mode === "paper") return;
    const open = this.ledger.orders(mode).filter(order => order.side === "BUY" &&
      !order.cancelRequested && (order.status === "NEW" || order.status === "PARTIALLY_FILLED"));
    if (!open.length) return;
    const credentials = this.key();
    for (const order of open) {
      try {
        const response = await this.venue.cancel(credentials, order, () => {
          if (!this.ledger.requestCancel(order.id, this.now())) fail("order", "รายการนี้ถูกตรวจหรือยกเลิกไปแล้ว");
        });
        await this.applyVenue(order, credentials, response);
      } catch {
        const current = this.ledger.getOrder(order.id);
        if (current?.cancelRequested && needsReview(current)) {
          this.ledger.merge({ ...current, status: "unknown_outcome", accounted: false, message: "ยังยืนยันผลการยกเลิกไม่ได้ กดตรวจคำสั่งเดิม" }, this.now());
        }
      }
    }
  }

  resume(mode: Mode) {
    this.requireWriter();
    if (this.ledger.orders(mode).some(needsReview)) fail("pending", "ตรวจผลคำสั่งก่อนเปิดไม้ใหม่");
    this.ledger.halt(mode, false, this.now());
  }

  async state(mode: Mode): Promise<TradeState> {
    const writable = this.writer();
    let connection: TradeState["live"] = "disconnected";
    let liveMessage = "ยังไม่เชื่อมบัญชี Binance TH";
    let liveKey: Credentials | null = null, account: Account | null = null;
    if (mode === "confirm") {
      try {
        liveKey = this.vault();
        if (liveKey) {
          this.ledger.checkAccount(hash(liveKey.key));
          account = await this.venue.account(liveKey);
          connection = liveKey.pilot && account.canTrade ? "pilot" : "read_only";
          liveMessage = connection === "pilot" ? "Pilot BTCTHB ผู้ใช้ยืนยันทุกคำสั่ง" : "อ่านยอดบัญชีเท่านั้น";
        }
      } catch (error) { liveMessage = error instanceof Fault ? error.message : "ตรวจบัญชี Binance TH ไม่สำเร็จ"; }
    }
    const position = this.ledger.position(mode);
    const orders = this.ledger.orders(mode);
    const bids = new Map<string, { gross: Dec; fee: Dec }>();
    let review: string | null = null;
    if (position) {
      try {
        const [book, rawFee] = await Promise.all([
          this.venue.book(position.symbol),
          mode === "paper" ? Promise.resolve(paperFee) : liveKey && account ? this.venue.fee(liveKey, position.symbol) : Promise.resolve(null)
        ]);
        if (this.now() - book.at <= quoteLife) {
          const bid = positive(book.bids[0][0]), qty = positive(position.quantity);
          const outcome = depth(book, "SELL", new D(0), qty);
          if (rawFee !== null && outcome.quantity.eq(qty)) bids.set(position.symbol, { gross: outcome.gross, fee: amount(rawFee) });
          if (position.invalidation && bid.lte(position.invalidation)) review = "ราคาถึงจุดทบทวนแล้ว โปรดตรวจสถานะก่อนขาย";
          else if (position.openedAt && Math.floor(this.now() / DAY) - Math.floor(position.openedAt / DAY) >= 5) review = "ผ่านเวลาทบทวนห้าวันแล้ว";
        }
      } catch { review = "ยังอ่านราคาออกปัจจุบันไม่ได้"; }
    }
    const metrics = this.ledger.metrics(mode, this.now(), bids, writable);
    const config = this.ledger.config(mode);
    if (writable && config.caps && metrics.daily !== null && metrics.daily.lte(new D(config.caps.dailyLoss).neg())) {
      this.ledger.halt(mode, true, this.now(), true);
    }
    const base = position?.symbol.slice(0, -3);
    return {
      mode, caps: config.caps, halted: this.ledger.config(mode).halted, writable, position,
      cash: mode === "paper" ? this.ledger.funds(mode).toFixed() : account?.free.get("THB") ?? null,
      sellable: !position ? null : mode === "paper" ? position.quantity :
        account && base ? D.min(amount(position.quantity), amount(account.free.get(base) ?? "0")).toFixed() : null,
      orders: orders.slice(-30).reverse().map(cleanOrder), net: metrics.net?.toFixed() ?? null, daily: metrics.daily?.toFixed() ?? null,
      live: connection, liveMessage, openUnknown: orders.some(needsReview), review, dust: this.ledger.dust(mode)
    };
  }
}
