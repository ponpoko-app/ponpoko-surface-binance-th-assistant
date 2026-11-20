import type { Caps, Fill, Order, Side, Ticket } from "../model.ts";
import type { Book, Rule, SymbolInfo } from "./venue.ts";
import { amount, ceilTo, D, decimalText, fail, floorTo, positive, type Dec } from "./util.ts";

export const paperFee = "0.0025";
export const defaultCaps: Caps = { order: "1000", exposure: "1000", planLoss: "100", dailyLoss: "200" };
export const paperCash = "10000";

export function parseCaps(value: Record<string, unknown>): Caps {
  const caps = {
    order: positive(value.order), exposure: positive(value.exposure),
    planLoss: positive(value.planLoss), dailyLoss: positive(value.dailyLoss)
  };
  if (caps.order.gt(caps.exposure) || caps.planLoss.gt(caps.order) || caps.planLoss.gt(caps.dailyLoss)) {
    fail("caps", "เพดานต่อคำสั่งต้องไม่เกินเพดานสถานะ และขาดทุนต่อแผนต้องไม่เกินยอดคำสั่งหรือขาดทุนต่อวัน");
  }
  return Object.fromEntries(Object.entries(caps).map(([key, n]) => [key, n.toFixed()])) as Caps;
}

function required(info: SymbolInfo, name: string): Rule {
  const filter = info.filters.find(rule => rule.filterType === name);
  if (!filter) fail("rules", "ข้อมูลขั้นราคาและปริมาณของคู่นี้ไม่ครบ");
  return filter;
}

export function pairRules(info: SymbolInfo) {
  const price = required(info, "PRICE_FILTER"), lot = required(info, "LOT_SIZE");
  const notional = info.filters.filter(rule => rule.filterType === "MIN_NOTIONAL" || rule.filterType === "NOTIONAL");
  const minNotional = D.max(0, ...notional.map(rule => amount(rule.minNotional)));
  const maxNotional = D.min("1e50", ...notional.filter(rule => rule.maxNotional !== undefined).map(rule => positive(rule.maxNotional)));
  const supported = new Set(["PRICE_FILTER", "LOT_SIZE", "MIN_NOTIONAL", "NOTIONAL", "PERCENT_PRICE", "PERCENT_PRICE_BY_SIDE", "MARKET_LOT_SIZE", "ICEBERG_PARTS", "MAX_NUM_ORDERS", "MAX_NUM_ALGO_ORDERS", "MAX_NUM_ICEBERG_ORDERS", "TRAILING_DELTA"]);
  return {
    tick: positive(price.tickSize), step: positive(lot.stepSize), minPrice: amount(price.minPrice), maxPrice: amount(price.maxPrice),
    minQty: amount(lot.minQty), maxQty: positive(lot.maxQty), minNotional, maxNotional,
    bands: info.filters.filter(rule => rule.filterType === "PERCENT_PRICE" || rule.filterType === "PERCENT_PRICE_BY_SIDE"),
    liveSupported: info.filters.every(rule => supported.has(rule.filterType))
  };
}

export function spread(book: Book) {
  const bid = positive(book.bids[0]?.[0]), ask = positive(book.asks[0]?.[0]);
  if (bid.gte(ask)) fail("book", "ราคาเสนอซื้อและขายไม่สอดคล้องกัน");
  return ask.minus(bid).div(ask.plus(bid).div(2));
}

export function depth(book: Book, side: Side, limit: Dec, quantity: Dec) {
  const levels = side === "BUY" ? book.asks : book.bids;
  let remaining = quantity;
  const levelsUsed: { price: Dec; qty: Dec }[] = [];
  for (const [rawPrice, rawQty] of levels) {
    const price = positive(rawPrice);
    if (remaining.lte(0) || (side === "BUY" ? price.gt(limit) : price.lt(limit))) break;
    const qty = D.min(remaining, positive(rawQty));
    levelsUsed.push({ price, qty });
    remaining = remaining.minus(qty);
  }
  return { levelsUsed, quantity: quantity.minus(remaining), gross: levelsUsed.reduce((sum, row) => sum.plus(row.qty.mul(row.price)), new D(0)) };
}

export async function checkBands(rules: ReturnType<typeof pairRules>, side: Side, price: Dec,
  average: (minutes: number) => Promise<string>) {
  const cache = new Map<number, Dec>();
  for (const band of rules.bands) {
    const minutes = Number(band.avgPriceMins);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) fail("rules", "ไม่รู้ช่วงเวลาตรวจกรอบราคาของคู่นี้");
    const reference = cache.get(minutes) ?? positive(await average(minutes));
    cache.set(minutes, reference);
    const prefix = side === "BUY" ? "bid" : "ask";
    const up = positive(band.filterType === "PERCENT_PRICE" ? band.multiplierUp : band[prefix + "MultiplierUp"]);
    const down = positive(band.filterType === "PERCENT_PRICE" ? band.multiplierDown : band[prefix + "MultiplierDown"]);
    if (price.lt(reference.mul(down)) || price.gt(reference.mul(up))) fail("price_band", "ราคา limit อยู่นอกกรอบราคาของ Binance TH");
  }
}

export function orderNumbers(input: {
  side: Side; price: string; budget?: string; invalidation?: string; fee: Dec; free: Dec;
  caps: Caps; daily: Dec | null; exposure: Dec; owned: Dec; rules: ReturnType<typeof pairRules>;
}) {
  const { side, rules, fee } = input;
  const requested = positive(input.price);
  const price = side === "BUY" ? floorTo(requested, rules.tick) : ceilTo(requested, rules.tick);
  if (price.lte(0) || price.lt(rules.minPrice) || (rules.maxPrice.gt(0) && price.gt(rules.maxPrice))) {
    fail("price", "ราคา limit อยู่นอกช่วงราคาที่คู่เงินรองรับ");
  }
  const maxQuantity = D.min(rules.maxQty, rules.maxNotional.div(price));
  let qty: Dec, stop: Dec | null = null, loss: Dec | null = null;
  if (side === "BUY") {
    const remainingDaily = input.daily?.plus(positive(input.caps.dailyLoss));
    if (remainingDaily == null || remainingDaily.lte(0)) fail("daily", "ยังคำนวณวงเงินขาดทุนวันนี้ไม่ได้หรือชนเพดานแล้ว");
    stop = floorTo(positive(input.invalidation), rules.tick);
    if (stop.lte(0) || stop.gte(price)) fail("exit", "จุดทบทวนต้องต่ำกว่าราคาเข้าและมากกว่าศูนย์");
    const exit = stop.mul("0.995").mul(new D(1).minus(fee).pow(2));
    const entryCost = price.mul(new D(1).plus(fee));
    const lossPerUnit = entryCost.minus(exit);
    const budget = input.budget ? positive(input.budget) : positive(input.caps.order);
    const money = D.min(budget, input.free, positive(input.caps.order), positive(input.caps.exposure).minus(input.exposure));
    qty = floorTo(D.max(0, D.min(maxQuantity, money.div(entryCost), positive(input.caps.planLoss).div(lossPerUnit), remainingDaily.div(lossPerUnit))), rules.step);
    loss = qty.mul(lossPerUnit);
    const exitQty = floorTo(qty.mul(new D(1).minus(fee)), rules.step);
    if (exitQty.lt(rules.minQty) || exitQty.mul(stop.mul("0.995")).lt(rules.minNotional)) {
      fail("minimum", `ยอดขายจำลองหลังค่าธรรมเนียมต่ำกว่าขั้นต่ำ ${rules.minNotional.toFixed()} บาทหรือขนาดขั้นต่ำของคู่`);
    }
  } else {
    qty = floorTo(D.min(input.owned, input.free, maxQuantity), rules.step);
  }
  const notional = price.mul(qty);
  if (qty.lte(0) || qty.lt(rules.minQty) || notional.lt(rules.minNotional)) {
    fail("minimum", `คำสั่งหลังปัดจำนวนต่ำกว่าขั้นต่ำ ${rules.minNotional.toFixed()} บาทหรือขนาดขั้นต่ำของคู่`);
  }
  return {
    price: decimalText(price), quantity: decimalText(qty), notional: decimalText(notional),
    fee: decimalText(notional.mul(fee)), maximumPayment: side === "BUY" ? decimalText(notional.mul(new D(1).plus(fee))) : null,
    invalidation: stop?.toFixed() ?? null, estimatedLoss: loss?.toFixed() ?? null
  };
}

export function simulatedFills(ticket: Ticket, book: Book, now: number): Fill[] {
  const rows = depth(book, ticket.side, positive(ticket.price), positive(ticket.quantity)).levelsUsed;
  return rows.map(({ price, qty }, i) => ({
    id: ticket.id + "-" + i, price: price.toFixed(), quantity: qty.toFixed(), quote: qty.mul(price).toFixed(),
    fee: qty.mul(ticket.side === "BUY" ? 1 : price).mul(paperFee).toFixed(),
    feeAsset: ticket.side === "BUY" ? ticket.base : "THB", at: now
  }));
}

export function fillSum(fills: Fill[]) {
  return fills.reduce((sum, fill) => sum.plus(amount(fill.quantity)), new D(0));
}

export function needsReview(order: Order) {
  return !order.accounted || ["NEW", "PARTIALLY_FILLED", "dispatching", "unknown_outcome"].includes(order.status);
}
