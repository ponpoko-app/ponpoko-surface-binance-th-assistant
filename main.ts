import { createSurfaceClient } from "@ponpoko-app/surface-sdk";
import { bindSurfaceTheme } from "@ponpoko-app/surface-sdk/theme";
import { pilotPair, type Caps, type MarketState, type Mode, type Order, type PreviewRequest, type Quote, type Side, type Ticket, type TradeState } from "./src/model.ts";
import { baht, copy, describeOrder, el, message, pair, preciseBaht, renderMarket, renderTicket, renderTrade, show } from "./src/ui.ts";

const input = (id: string) => el<HTMLInputElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const connected = window.parent !== window && new URLSearchParams(location.search).has("view");
const host = connected ? createSurfaceClient({ timeoutMs: 25_000 }) : null;
const unbind = host ? bindSurfaceTheme(host) : () => {};
let mode: Mode = "paper";
let current: TradeState | null = null;
let market: MarketState | null = null;
let activeTicket: Ticket | null = null;
let marketPoll = 0;
let busy = false;
let haltBusy = false;
let modeGeneration = 0;
let quoteGeneration = 0;
let marketVersion = "";
let formVersion = "";
let settingsVersion = "";

function call<T>(method: string, params?: unknown) {
  if (!host) return Promise.reject(new Error("เปิด surface นี้ใน Ponpoko เพื่อใช้งาน"));
  return host.backend<T>(method, params);
}

function explain(error: unknown) {
  return error instanceof Error && error.message ? error.message : "ทำรายการไม่ได้ ลองโหลดสถานะใหม่";
}

function disabled() {
  const sound = Boolean(current?.writable && !current.openUnknown &&
    (mode === "paper" || (current.live === "pilot" && current.caps)));
  const side = select("side").value;
  const allowBuy = sound && !current?.halted && !current?.position;
  const allowSell = sound && Boolean(current?.position);
  const editing = !busy && Boolean(select("symbol").value) && (side === "SELL" ? allowSell : allowBuy);
  button("preview").disabled = !editing;
  input("limit").disabled = !editing;
  input("budget").disabled = !editing || side === "SELL";
  input("invalidation").disabled = !editing || side === "SELL";
  button("suggest").disabled = busy || !allowBuy || !market?.ranking.some(row => row.score > 0 && (mode === "paper" || row.symbol === pilotPair));
  button("halt").disabled = haltBusy || !current?.writable;
  button("settings-toggle").disabled = !current?.writable;
  button("refresh").disabled = !host;
  button("sync").disabled = !host;
  button("submit").disabled = busy || !activeTicket || activeTicket.expiresAt <= Date.now() ||
    (activeTicket.side === "BUY" ? !allowBuy : !allowSell);
}

function populatePairs() {
  const previous = select("symbol").value;
  let pairs = market?.pairs ?? [];
  if (mode === "confirm") pairs = pairs.filter(row => row.symbol === pilotPair);
  if (select("side").value === "SELL") {
    const position = current?.position;
    pairs = position ? [{ symbol: position.symbol, base: position.symbol.slice(0, -3) }] : [];
  }
  const version = JSON.stringify([mode, select("side").value, pairs.map(row => row.symbol)]);
  if (version !== formVersion) {
    formVersion = version;
    const empty = new Option(pairs.length ? "เลือกคู่เงินบาท" : "ยังไม่มีคู่ที่ใช้ได้", "");
    const picker = select("symbol");
    picker.replaceChildren(empty, ...pairs.map(item => new Option(pair(item.symbol), item.symbol)));
    picker.value = previous;
    if (select("side").value === "SELL" && pairs[0]) picker.value = pairs[0].symbol;
    picker.disabled = !pairs.length;
  }
  readSignalNote();
  disabled();
}

function readMarket(data: MarketState) {
  if (!data || !Array.isArray(data.pairs) || !Array.isArray(data.ranking) || !Array.isArray(data.excluded)) {
    throw new Error("ไม่มีข้อมูลตลาดให้แสดง ลองโหลดใหม่");
  }
  market = data;
  const version = JSON.stringify([data.signalDay, data.fetchedAt, data.status, data.message]);
  if (marketVersion !== version) {
    marketVersion = version;
    renderMarket(data, select("symbol").value, symbol => void choosePair(symbol, "BUY", true));
  }
  populatePairs();
}

const tableSize = new ResizeObserver(() => {
  const table = el("market-table");
  const horizontal = !table.hidden && table.scrollWidth > table.clientWidth + 1;
  const vertical = !table.hidden && table.scrollHeight > table.clientHeight + 1;
  message("market-scroll", horizontal ? "เลื่อนตารางเพื่อดูทุกคอลัมน์" : vertical ? "เลื่อนตารางเพื่อดูทุกคู่" : "");
});
tableSize.observe(el("market-table"));

async function refreshMarket() {
  clearTimeout(marketPoll);
  const read = async (tries: number) => {
    try {
      const latest = await call<MarketState>(tries === 0 ? "market.refresh" : "market.snapshot");
      readMarket(latest);
      if (tries < 25 && (latest.status === "loading" || latest.message === "กำลังอัปเดตข้อมูลตลาด")) {
        marketPoll = window.setTimeout(() => { void read(tries + 1); }, 1_300);
      }
    } catch (error) {
      show("market-status", true);
      copy("market-status", explain(error));
    }
  };
  await read(0);
}

async function refreshTrade() {
  const generation = modeGeneration;
  try {
    const data = await call<TradeState>("trade.state", { mode });
    if (generation !== modeGeneration) return;
    current = data;
    renderTrade(data, id => void reconcile(id), symbol => void choosePair(symbol, "SELL"));
    const state = data.caps ? JSON.stringify(data.caps) : "";
    if (settingsVersion !== state) {
      settingsVersion = state;
      for (const field of ["order", "exposure", "planLoss", "dailyLoss"] as const) {
        (el<HTMLFormElement>("caps").elements.namedItem(field) as HTMLInputElement).value = data.caps?.[field] ?? "";
      }
    }
    copy("halt", data.halted ? data.openUnknown ? "หยุดอยู่ / ตรวจคำสั่ง" : "เปิดรับไม้ใหม่" : "หยุดเปิดไม้ใหม่");
    if (!data.writable) message("banner", "อีกหน้าต่างควบคุมการส่งคำสั่งอยู่");
    else if (data.halted) message("banner", "หยุดเปิดไม้ใหม่แล้ว ยังตรวจผลและเตรียมขายสถานะเดิมได้");
    else if (data.openUnknown) message("banner", "มีคำสั่งที่ต้องตรวจผล กดตรวจผลเดิมในประวัติ");
    else if (mode === "confirm") message("banner", data.live === "pilot" && !data.caps ? "ตั้งเพดานก่อนส่งคำสั่งเงินจริง" : data.liveMessage);
    else message("banner", "");
    if (mode === "confirm" && (data.live !== "pilot" || !data.caps) && el("settings").hidden && settingsVersion !== "shown") {
      button("settings-toggle").setAttribute("aria-expanded", "true");
      show("settings", true);
    }
    populatePairs();
  } catch (error) {
    if (generation !== modeGeneration) return;
    current = null;
    message("banner", explain(error), true);
    disabled();
  }
}

function switchMode(next: Mode) {
  if (mode === next || busy) return;
  mode = next;
  modeGeneration += 1;
  quoteGeneration += 1;
  settingsVersion = "changed";
  current = null;
  dismiss();
  for (const item of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    item.disabled = item.dataset.mode === next;
    item.setAttribute("aria-pressed", String(item.disabled));
  }
  copy("ticket-mode", next === "paper" ? "เงินจำลอง" : "เงินจริงที่ Binance TH");
  el("ticket-mode").classList.toggle("live-text", next === "confirm");
  for (const id of ["limit", "budget", "invalidation"]) input(id).value = "";
  copy("quote", "");
  copy("daily", "—");
  copy("net", "—");
  copy("cash", "—");
  show("holding", false);
  show("history-table", false);
  show("history-status", true);
  show("settings", false);
  button("settings-toggle").setAttribute("aria-expanded", "false");
  select("side").value = "BUY";
  handleSide();
  message("trade-status", "");
  message("banner", "กำลังอ่านสถานะ");
  populatePairs();
  void refreshTrade();
}

function handleSide() {
  const buy = select("side").value === "BUY";
  show("buy-fields", buy);
  input("invalidation").required = buy;
  populatePairs();
}

function readSignalNote() {
  const rows = market?.ranking ?? [];
  const eligible = rows.some(row => row.score > 0 && (mode === "paper" || row.symbol === pilotPair));
  message("signal-note", rows.length && !eligible ? "ยังไม่มีแผนจากอันดับที่ผ่านเกณฑ์ เลือกคู่เองได้" : "");
}

async function choosePair(symbol: string, side: Side, signal = false) {
  if (busy) return;
  if (mode === "confirm" && symbol !== pilotPair) {
    message("trade-status", "คู่นี้มีไว้ดูอันดับหรือจำลอง Pilot เงินจริงรองรับ BTC/THB", true);
    return;
  }
  dismiss();
  select("side").value = side;
  handleSide();
  select("symbol").value = symbol;
  if ((signal || side === "SELL") && matchMedia("(max-width: 900px)").matches) {
    el("ticket-heading").scrollIntoView({ block: "start" });
  }
  document.querySelectorAll<HTMLElement>("[data-symbol]").forEach(row => { row.dataset.selected = String(row.dataset.symbol === symbol); });
  input("limit").value = "";
  input("invalidation").value = "";
  copy("quote", symbol ? "กำลังอ่านสมุดคำสั่ง" : "");
  message("trade-status", "");
  if (!symbol) return;
  const generation = ++quoteGeneration;
  try {
    const quote = await call<Quote>("trade.quote", { symbol, signal });
    if (generation !== quoteGeneration) return;
    input("limit").value = side === "SELL" ? quote.bid : quote.ask;
    input("invalidation").value = quote.suggestedInvalidation ?? "";
    copy("quote", `เสนอซื้อ ${preciseBaht(quote.bid)} / เสนอขาย ${preciseBaht(quote.ask)} / ขั้นต่ำ ${baht(quote.minNotional)}`);
  } catch (error) {
    if (generation === quoteGeneration) copy("quote", explain(error));
  }
  disabled();
}

function dismiss() {
  activeTicket = null;
  show("review", false);
  show("ticket-form", true);
  disabled();
}

function openTicket(ticket: Ticket) {
  activeTicket = ticket;
  renderTicket(ticket);
  updateExpiry();
  el("review-heading").setAttribute("tabindex", "-1");
  el("review-heading").focus();
}

async function openManual() {
  const request: PreviewRequest = {
    mode, side: select("side").value as Side, symbol: select("symbol").value, approach: "manual",
    price: input("limit").value, budget: input("budget").value || undefined, invalidation: input("invalidation").value || undefined
  };
  await action(async () => openTicket(await call<Ticket>("trade.preview", request)));
}

async function suggest() {
  await action(async () => {
    const ranked = (market?.ranking ?? []).filter(row => row.score > 0 && (mode === "paper" || row.symbol === pilotPair));
    let reason = "ไม่มีคู่ที่ผ่านเกณฑ์ในโหมดนี้";
    for (const row of ranked.slice(0, 8)) {
      try {
        const review = await call<Ticket>("trade.preview", { mode, side: "BUY", symbol: row.symbol, approach: "momentum", budget: input("budget").value || undefined });
        select("symbol").value = review.symbol;
        input("limit").value = review.price;
        input("invalidation").value = review.invalidation ?? "";
        return openTicket(review);
      } catch (error) { reason = explain(error); }
    }
    throw new Error(reason);
  });
}

async function action(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  message("trade-status", "กำลังตรวจ");
  disabled();
  try { await work(); if (el("trade-status").textContent === "กำลังตรวจ") message("trade-status", ""); }
  catch (error) { message("trade-status", explain(error), true); }
  finally { busy = false; disabled(); }
}

async function send() {
  const ticket = activeTicket;
  if (!ticket) return;
  await action(async () => {
    try {
      const order = await call<Order>("trade.submit", { id: ticket.id });
      dismiss();
      message("trade-status", describeOrder(order), order.status === "unknown_outcome" || order.status === "REJECTED");
    } catch (error) {
      dismiss();
      message("trade-status", explain(error) + " ตรวจประวัติก่อนส่งใหม่", true);
    } finally { await refreshTrade(); }
  });
}

async function reconcile(id: string) {
  await action(async () => {
    const order = await call<Order>("trade.reconcile", { id });
    message("trade-status", describeOrder(order), order.status === "unknown_outcome");
    await refreshTrade();
  });
}

function updateExpiry() {
  if (!activeTicket) return;
  const seconds = Math.max(0, Math.ceil((activeTicket.expiresAt - Date.now()) / 1_000));
  copy("expiry", seconds ? `เหลือ ${seconds} วินาที` : "หมดอายุ เปิดใบใหม่");
  disabled();
}

function bind() {
  for (const item of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) item.addEventListener("click", () => switchMode(item.dataset.mode as Mode));
  button("refresh").addEventListener("click", () => void refreshMarket());
  button("sync").addEventListener("click", () => void refreshTrade());
  select("symbol").addEventListener("change", () => void choosePair(select("symbol").value, select("side").value as Side));
  select("side").addEventListener("change", () => void choosePair(select("symbol").value || current?.position?.symbol || "", select("side").value as Side));
  el("ticket-form").addEventListener("submit", event => { event.preventDefault(); void openManual(); });
  button("suggest").addEventListener("click", () => void suggest());
  button("submit").addEventListener("click", () => void send());
  button("dismiss").addEventListener("click", dismiss);
  button("settings-toggle").addEventListener("click", () => {
    const opening = Boolean(el("settings").hidden);
    show("settings", opening);
    button("settings-toggle").setAttribute("aria-expanded", String(opening));
  });
  el<HTMLFormElement>("caps").addEventListener("submit", event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));
    void action(async () => {
      await call("trade.settings", { mode, caps: values as Caps });
      dismiss();
      message("trade-status", "บันทึกเพดานแล้ว");
      await refreshTrade();
    });
  });
  button("halt").addEventListener("click", () => {
    if (!current || !host || haltBusy) return;
    const selectedMode = mode;
    const resume = current.halted && !current.openUnknown;
    haltBusy = true;
    dismiss();
    void call(resume ? "trade.resume" : "trade.halt", { mode: selectedMode })
      .catch(error => message("trade-status", explain(error), true)).finally(() => { haltBusy = false; void refreshTrade(); });
  });
  el<HTMLAnchorElement>("venue-link").addEventListener("click", event => {
    if (!host) return;
    event.preventDefault();
    void host.call("host.platform", "link.open", { href: "https://www.binance.th/" }).catch(error => message("banner", explain(error), true));
  });
}

bind();
disabled();
if (!host) {
  copy("market-status", "เปิด surface ใน Ponpoko เพื่ออ่านตลาดและส่งคำสั่ง");
} else {
  void host.ready().then(() => { void refreshMarket(); void refreshTrade(); })
    .catch(error => message("banner", explain(error), true));
}
const expiryTimer = window.setInterval(updateExpiry, 500);
const marketTimer = window.setInterval(() => { if (host && document.visibilityState === "visible") void refreshMarket(); }, 120_000);
const stateTimer = window.setInterval(() => { if (host && current?.position && document.visibilityState === "visible" && !busy) void refreshTrade(); }, 25_000);
addEventListener("pagehide", () => {
  clearTimeout(marketPoll);
  clearInterval(expiryTimer);
  clearInterval(marketTimer);
  clearInterval(stateTimer);
  tableSize.disconnect();
  unbind();
  host?.dispose();
}, { once: true });
