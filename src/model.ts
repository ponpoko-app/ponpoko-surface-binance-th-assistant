export type Mode = "paper" | "confirm";
export type Side = "BUY" | "SELL";
export type DecimalText = string;

export type Pair = { symbol: string; base: string };
export type RankedPair = Pair & { score: number; versusBtc: number; volume: string | null; rank: number };
export type MarketState = {
  pairs: Pair[];
  ranking: RankedPair[];
  excluded: { symbol: string; reason: string }[];
  signalDay: string | null;
  btcReturn: number | null;
  fetchedAt: number | null;
  status: "loading" | "ready" | "unmeasured" | "error";
  message: string;
};

export type Caps = { order: string; exposure: string; planLoss: string; dailyLoss: string };
export type Position = { symbol: string; quantity: string; cost: string; invalidation: string | null; openedAt: number | null };
export type OrderStatus = "dispatching" | "unknown_outcome" | "NEW" | "PARTIALLY_FILLED" | "FILLED" | "EXPIRED" | "CANCELED" | "REJECTED";
export type Fill = { id: string; price: string; quantity: string; quote: string; fee: string; feeAsset: string; at: number };
export type Order = {
  id: string; mode: Mode; symbol: string; base: string; side: Side; price: string; quantity: string;
  invalidation: string | null; status: OrderStatus; orderId: string | null; filledQuantity: string;
  accounted: boolean; fills: Fill[]; createdAt: number; message?: string;
};

export type Quote = Pair & {
  bid: string; ask: string; spread: string; at: number; suggestedInvalidation: string | null;
  minNotional: string; step: string;
};
export type Ticket = {
  id: string; mode: Mode; side: Side; symbol: string; base: string; price: string; quantity: string;
  notional: string; fee: string; maximumPayment: string | null; invalidation: string | null; estimatedLoss: string | null;
  estimatedFill: string; expiresAt: number; at: number; signalDay: string | null; approach: "manual" | "momentum";
};
export type TradeState = {
  mode: Mode; caps: Caps | null; cash: string | null; halted: boolean; writable: boolean;
  position: Position | null; sellable: string | null; orders: Order[]; net: string | null; daily: string | null;
  live: "disconnected" | "read_only" | "pilot"; liveMessage: string; openUnknown: boolean; review: string | null;
  dust: { symbol: string; quantity: string }[];
};
export type QuoteRequest = { symbol: string; signal?: boolean };
export type PreviewRequest = {
  mode: Mode; side: Side; symbol: string; price?: string; budget?: string; invalidation?: string;
  approach: "manual" | "momentum";
};

export const pairPattern = /^[A-Z0-9]{2,22}THB$/;
export const pilotPair = "BTCTHB";
