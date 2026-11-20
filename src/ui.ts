import type { MarketState, Mode, Order, Ticket, TradeState } from "./model.ts";

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const item = document.getElementById(id);
  if (!item) throw new Error("Missing element " + id);
  return item as T;
}
export function show(id: string, value: boolean) { el(id).hidden = !value; }
export function copy(id: string, text: string) { el(id).textContent = text; }

const currency = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2, notation: "compact" });
const time = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", second: "2-digit", day: "numeric", month: "short" });
const utcDay = new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", dateStyle: "medium" });

export function baht(value: string | null) { return value === null ? "—" : currency.format(Number(value)) + " ฿"; }
export function units(value: string) {
  const [whole, fraction] = value.split(".");
  const significant = fraction?.replace(/0+$/, "");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (significant ? "." + significant : "");
}
export function preciseBaht(value: string) { return units(value) + " ฿"; }
export function pair(symbol: string) { return symbol.slice(0, -3) + "/THB"; }
export function modeLabel(mode: Mode) { return mode === "paper" ? "เงินจำลอง" : "เงินจริงที่ Binance TH"; }
export function signed(value: number, suffix: string) { return (value > 0 ? "+" : "") + value.toFixed(2) + suffix; }
function direction(value: number) { return value > 0 ? "pos" : value < 0 ? "neg" : ""; }

function text(tag: string, value: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function button(value: string, action: () => void, style = "button secondary") {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = value;
  node.className = style;
  node.addEventListener("click", action);
  return node;
}

export function message(id: string, value: string, error = false) {
  const node = el(id);
  node.hidden = !value;
  node.textContent = value;
  node.dataset.error = String(error);
}

export function renderMarket(state: MarketState, selected: string, select: (symbol: string) => void) {
  const date = state.signalDay ? utcDay.format(new Date(state.signalDay + "T00:00:00Z")) : null;
  copy("market-date", date ? `แท่งปิด ${date} UTC / BTC ${state.btcReturn === null ? "—" : signed(state.btcReturn * 100, "%")}` : "ผลตอบแทนใน USDT เทียบ BTC");
  show("market-table", state.ranking.length > 0);
  show("market-status", state.ranking.length === 0);
  message("market-refresh-status", state.ranking.length ? state.message : "");
  copy("market-status", state.message || "ยังไม่มีข้อมูลครบสำหรับจัดอันดับ");
  const body = el("ranks");
  body.replaceChildren(...state.ranking.map(item => {
    const row = document.createElement("tr");
    row.dataset.selected = String(selected === item.symbol);
    row.dataset.symbol = item.symbol;
    const name = document.createElement("td");
    const volume = item.volume === null ? "—" : compact.format(Number(item.volume)) + " ฿";
    name.append(button(pair(item.symbol), () => select(item.symbol), "cell-button"),
      text("span", "24 ชม. " + volume, "volume-inline"));
    row.append(text("td", String(item.rank)), name, text("td", signed(item.score * 100, "%"), direction(item.score)),
      text("td", signed(item.versusBtc * 100, " จุด"), direction(item.versusBtc)),
      text("td", volume, "volume-column"));
    return row;
  }));
  show("exclusions", state.excluded.length > 0);
  copy("exclusion-label", `คู่ที่ไม่ได้จัดอันดับ (${state.excluded.length})`);
  const items = new Map<string, string[]>();
  for (const row of state.excluded) items.set(row.reason, [...(items.get(row.reason) ?? []), pair(row.symbol)]);
  el("exclusion-items").replaceChildren(...[...items.entries()].map(([reason, symbols]) => text("li", reason + " — " + symbols.join(", "))));
}

const orderStatus: Record<Order["status"], string> = {
  dispatching: "กำลังส่งหรือรอตรวจผล", unknown_outcome: "ยังไม่ทราบผล", NEW: "Exchange รับคำสั่งแล้ว",
  PARTIALLY_FILLED: "จับคู่บางส่วน", FILLED: "จับคู่ครบ", EXPIRED: "หมดอายุ", CANCELED: "ยกเลิกแล้ว", REJECTED: "ถูกปฏิเสธ"
};
export function describeOrder(order: Order) {
  const currencyName = order.mode === "paper" ? "จำลอง" : "เงินจริง";
  return `${currencyName} ${pair(order.symbol)}: ${orderStatus[order.status]}${order.filledQuantity !== "0" ? " " + units(order.filledQuantity) + " เหรียญ" : ""}`;
}
function waiting(order: Order) {
  return !order.accounted || ["dispatching", "unknown_outcome", "NEW", "PARTIALLY_FILLED"].includes(order.status);
}

function fillDetails(order: Order) {
  const breakdown = document.createElement("details");
  breakdown.append(text("summary", "รายการที่จับคู่"));
  const list = document.createElement("ul");
  for (const fill of order.fills) {
    list.append(text("li", `${units(fill.quantity)} ${order.base} ที่ ${preciseBaht(fill.price)} / ค่าธรรมเนียม ${units(fill.fee)} ${fill.feeAsset}`));
  }
  breakdown.append(list);
  return breakdown;
}

export function renderTrade(state: TradeState, reconcile: (id: string) => void, close: (symbol: string) => void) {
  copy("cash", baht(state.cash));
  copy("net", baht(state.net));
  copy("daily", baht(state.daily));
  el("net").className = state.net === null ? "" : direction(Number(state.net));
  el("daily").className = state.daily === null ? "" : direction(Number(state.daily));
  copy("connection", state.mode === "paper" ? "บัญชีเงินจำลองตั้งต้น 10,000 บาท" : state.liveMessage);
  show("live-help", state.mode === "confirm" && state.live !== "pilot");
  copy("ticket-mode", modeLabel(state.mode));
  el("ticket-mode").classList.toggle("live-text", state.mode === "confirm");
  const holding = el("holding");
  holding.replaceChildren();
  if (state.position) {
    const position = state.position;
    holding.append(text("strong", `ถือ ${units(position.quantity)} ${position.symbol.slice(0, -3)}`),
      text("span", `ขายได้ ${state.sellable == null ? "รออ่านยอด" : units(state.sellable)}`));
    if (position.invalidation) holding.append(text("span", `ทบทวนที่ ${baht(position.invalidation)}`));
    if (state.mode === "confirm") holding.append(text("span", "ยังไม่มีคำสั่งป้องกันที่ Binance TH", "neg"));
    if (state.review) holding.append(text("span", state.review));
    holding.append(button("เตรียมขาย", () => close(position.symbol)));
  }
  if (state.dust.length) holding.append(text("span", "เศษต่ำกว่าขั้นปริมาณ: " + state.dust.map(row => units(row.quantity) + " " + row.symbol.slice(0, -3)).join(", ")));
  show("holding", Boolean(state.position || state.dust.length));
  show("history-table", state.orders.length > 0);
  show("history-status", state.orders.length === 0);
  copy("history-status", "ยังไม่มีคำสั่งในโหมดนี้");
  el("orders").replaceChildren(...state.orders.map(order => {
    const row = document.createElement("tr");
    const filled = text("td", `${units(order.filledQuantity)} / ${units(order.quantity)}`);
    const status = text("td", orderStatus[order.status]);
    if (order.message) status.append(text("p", order.message, "quiet"));
    const details = document.createElement("td");
    if (waiting(order)) details.append(button("ตรวจผลเดิม", () => reconcile(order.id)));
    if (order.orderId) details.append(text("p", "#" + order.orderId, "quiet"));
    if (order.fills.length) details.append(fillDetails(order));
    row.append(text("td", time.format(order.createdAt)),
      text("td", `${order.side === "BUY" ? "ซื้อ" : "ขาย"} ${pair(order.symbol)}`),
      filled, status, details);
    return row;
  }));
}

export function renderTicket(ticket: Ticket) {
  show("review", true);
  show("ticket-form", false);
  const rows = [
    ["คู่และโหมด", pair(ticket.symbol) + " / " + modeLabel(ticket.mode)],
    ["คำสั่ง", ticket.side === "BUY" ? "ซื้อ Limit IOC" : "ขาย Limit IOC"],
    ["ราคา limit", preciseBaht(ticket.price)],
    ["จำนวน", units(ticket.quantity) + " " + ticket.base],
    ["ค่าธรรมเนียมโดยประมาณ", baht(ticket.fee)],
    [ticket.side === "BUY" ? "จ่ายสูงสุดโดยประมาณ" : "มูลค่าที่ราคา limit ก่อนค่าธรรมเนียม", baht(ticket.maximumPayment ?? ticket.notional)],
    ...(ticket.estimatedLoss ? [["ขาดทุนจำลองที่จุดทบทวน", baht(ticket.estimatedLoss)]] : [])
  ];
  el("review-lines").replaceChildren(...rows.map(([key, value]) => {
    const row = document.createElement("div");
    row.append(text("dt", key), text("dd", value));
    return row;
  }));
  copy("review-exit", ticket.side === "BUY" && ticket.invalidation
    ? `จุดทบทวน ${preciseBaht(ticket.invalidation)} ผู้ใช้จัดการขายเอง ${ticket.mode === "confirm" ? "ยังไม่มี stop บน Binance TH" : ""}` : "");
  copy("submit", ticket.mode === "paper" ? "ยืนยันจำลอง" : ticket.side === "BUY" ? "ยืนยันซื้อด้วยเงินจริง" : "ยืนยันขายด้วยเงินจริง");
}
