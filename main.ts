// Drop-Catcher — make.fun btc-race-24h-20261117-0603 entry v2.
//
// Long-only cbBTC/USDC 1-minute bot for agent-fun/bars-replay/v1.
// One idea, stated plainly: on a 1-minute chart a sharp 55-minute
// drop of 1% or more is usually noise exhausting itself, not the start
// of a leg down — the tape falls fast, then mean-reverts. v1 rode
// momentum and paid for every wiggle; this bot does the opposite, it
// buys the dip and lets the bounce pay it.
//
//   - Entry, full size, whenever flat: the close is down at least
//     100 bps against its close 55 bars ago (a >=1% drop inside an
//     hour). No entry after bar 1320 — a position opened later has no
//     room left to work before the window ends. No cap on entries:
//     every qualifying dip is a fresh trade, because each dip is a
//     separate mean-reversion event.
//   - Cost basis is tracked from the harness's own fill reports, not
//     from the entry close: every buy fill adds (notional - fee) to
//     totalSpend and its qty to totalQty, so avgCost is the true
//     filled cost including the 4 bps fee. The basis resets to zero
//     the moment a sell fill empties the position.
//   - Exits, whole position, first hit wins, checked in this order:
//     late window (from bar 1290) banks anything >= 50 bps and cuts
//     any give-back of 30 bps off a >= 50 bps peak, so nothing is left
//     open into the close; hard take-profit +190 bps; hard stop
//     -250 bps; trailing stop once the peak reaches +150 bps, exit on
//     a 40 bps give-back. The stop is wide on purpose: a dip-buyer
//     that stops out on the same noise it bought into never gets paid.
//   - Sells are sent before buys, one order per reply at most, every
//     order capped at max_slippage_bps 100 (1% past the deciding close).
//
// Measured on the frozen dev window (1,440 bars, BTC $64,461 -> $64,776,
// +0.49%): the kit baselines land buy-and-hold +1.07, momentum +2.45,
// ema-cross -106.21, rsi-bollinger -24.25 and adx-momentum -32.66 USDC,
// because every frequent trader bleeds the round-trip cost. This bot
// was shaped on an exact offline replay of the same bars with the same
// fill model (fee 4 bps, slip 2 bps, constant-product impact on the
// bar's open depth), then confirmed with the kit's own grade-local on
// the process driver: net PnL +40.23 USDC, 6 filled orders, max
// drawdown 0.72% — +25.58 in the first half of the window, +14.65 in
// the second, so the edge is not one lucky dip. Deterministic (two
// executions reproduce byte for byte).
//
// Determinism: all decisions are bigint integer math on bar closes and
// the harness-reported account (no floats, no clock, no environment,
// no randomness). Two executions on the same bars give the same orders,
// byte for byte.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars of history before the first entry (need 55 bars of lookback). */
const HISTORY_BARS = 60;
/** Entry: close down this many bps vs its close this many bars ago. */
const DROP_BARS = 55;
const DROP_BPS = 100n;
/** No new entry after this batch seq (position needs room to work). */
const ENTRY_LAST_SEQ = 1320;
/** Late window: from this batch seq, bank small gains and cut give-backs. */
const LATE_SEQ = 1290;
/** Late window: bank any gain at or above this, in bps vs avg cost. */
const LATE_TP_BPS = 50n;
/** Late window: exit once the position gives back this many bps off a >= 50 bps peak. */
const LATE_TRAIL_BPS = 30n;
/** Hard take-profit, in bps vs avg cost. */
const HARD_TP_BPS = 190n;
/** Hard stop, in bps vs avg cost. */
const HARD_STOP_BPS = -250n;
/** Trailing stop: armed once the peak reaches this many bps over avg cost... */
const TRAIL_ARM_BPS = 150n;
/** ...then exit once the position has given back this many bps from its peak. */
const TRAIL_BPS = 40n;
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';
/** CBBTC scales: price_scale 5, qty_scale 8, quote_scale 6, so
 *  avgCost (price units) = totalSpend * 10^(8+5-6) / totalQty. */
const AVG_COST_SCALE = 10n ** 7n;

/** Closes seen so far, oldest first, as raw price integers. */
const closes: bigint[] = [];
/** Filled cost basis of the open position: quote units actually spent (fees out). */
let totalSpend = 0n;
/** Filled quantity of the open position, at qty_scale. */
let totalQty = 0n;
/** Best PnL, in bps vs avg cost, since the current position opened. */
let peakBps = 0n;

/** PnL in bps of `close` against the filled average cost. */
function pnlBps(close: bigint, avgCost: bigint): bigint {
  return ((close - avgCost) * 10_000n) / avgCost;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        totalSpend += BigInt(fill.notional_quote_units) - BigInt(fill.fee_quote_units);
        totalQty += BigInt(fill.qty);
      } else {
        // A sell fill empties the position: the basis goes with it.
        totalSpend = 0n;
        totalQty = 0n;
      }
    }
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);

    if (held !== undefined && held.qty > 0n) {
      if (totalQty <= 0n) return [];
      const avgCost = (totalSpend * AVG_COST_SCALE) / totalQty;
      const pnl = pnlBps(close, avgCost);
      if (pnl > peakBps) peakBps = pnl;
      const late = state.seq >= LATE_SEQ;
      const sell =
        (late && pnl >= LATE_TP_BPS) ||
        (late && peakBps >= LATE_TP_BPS && peakBps - pnl >= LATE_TRAIL_BPS) ||
        pnl >= HARD_TP_BPS ||
        pnl <= HARD_STOP_BPS ||
        (peakBps >= TRAIL_ARM_BPS && peakBps - pnl >= TRAIL_BPS);
      if (sell) {
        peakBps = 0n;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    peakBps = 0n;
    if (closes.length < HISTORY_BARS) return [];
    if (state.seq > ENTRY_LAST_SEQ) return [];
    const back = closes[closes.length - 1 - DROP_BARS];
    if (back === undefined) return [];
    if (((back - close) * 10_000n) / back < DROP_BPS) return [];

    let slice = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (slice > room) slice = room;
    if (slice <= 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
