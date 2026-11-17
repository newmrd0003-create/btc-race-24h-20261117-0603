// Patient Momentum Rider — make.fun btc-race-24h-20261117-0603 entry.
//
// Long-only cbBTC/USDC 1-minute bot for agent-fun/bars-replay/v1.
// One idea, stated plainly: on a 1-minute chart the noise is ~12 bps a
// minute while a full-size round trip costs ~26-36 bps in fee, slippage
// and own price impact. A bot that trades every wiggle pays the market
// for the privilege of churning, so this bot trades rarely and only
// after the tape has had time to say something.
//
//   - It waits 240 bars (4 hours) before its first entry. The first
//     hours of a 24-hour window are chop more often than trend; the
//     history also seeds the 24-bar momentum read. In a calm market the
//     bot simply holds cash rather than manufacturing trades.
//   - Entry, full size, at most 3 per run: the close is above its close
//     24 bars ago (24-bar momentum >= 0). No cross, no oscillator, no
//     second-guessing: if the last 24 minutes netted up, ride it.
//   - Exits, whole position, no exceptions: a hard stop 100 bps under
//     the close that triggered the entry, and a trailing stop of 70 bps
//     once the position has peaked 80 bps above that close. A 60-bar
//     cooldown follows any losing exit, so one bad read cannot chain
//     into three.
//   - Sells are sent before buys, one order per reply at most, every
//     order capped at max_slippage_bps 100 (1% past the deciding close).
//
// Measured on the frozen dev window (1,440 bars, BTC $64,461 -> $64,776,
// +0.49%, range -0.9%..+1.6%): the kit baselines land buy-and-hold
// +1.07, momentum +2.45, ema-cross -106.21, rsi-bollinger -24.25 and
// adx-momentum -32.66 USDC, because every frequent trader bleeds the
// round-trip cost. This bot's shape was picked on a fast offline replay
// of the same bars with the same fill model (fee 4 bps, slip 2 bps,
// constant-product impact on the bar's open depth), then confirmed with
// the kit's own grade-local on the process driver: net PnL +15.41 USDC,
// 5 filled orders, max drawdown 1.36%, fees 2.42 USDC, deterministic
// (two executions reproduce byte for byte). The trailing-stop plateau
// is broad (trail 70-90 bps all clear the dev gate), not a knife-edge
// optimum, and the same shape loses the least of the trend family on
// the previous competition's falling dev window.
//
// Determinism: all decisions are bigint integer math on bar closes and
// the harness-reported account (no floats, no clock, no environment,
// no randomness). Two executions on the same bars give the same orders,
// byte for byte.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars of history before the first entry (4 hours of 1-minute bars). */
const HISTORY_BARS = 240;
/** Entry: close above its close this many bars ago. */
const MOMENTUM_BARS = 24;
/** Hard stop, in bps under the close that triggered the entry. */
const STOP_BPS = 100n;
/** Trailing stop: armed once the peak reaches this many bps over the entry close... */
const TRAIL_ARM_BPS = 80n;
/** ...then exit once the position has given back this many bps from its peak. */
const TRAIL_BPS = 70n;
/** Entries per run, and bars to wait after a losing exit. */
const MAX_ENTRIES = 3;
const COOLDOWN_BARS = 60;
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

/** Closes seen so far, oldest first, as raw price integers. */
const closes: bigint[] = [];
/** The close that triggered the position currently held (null when flat). */
let refClose: bigint | null = null;
/** Best PnL, in bps vs refClose, since the current position opened. */
let peakBps = 0n;
/** Filled buys this run (counted from the harness's own fill reports). */
let entries = 0;
/** Seq of the last losing exit; entries are barred for COOLDOWN_BARS after it. */
let lastLossSeq = -1_000_000_000;

/** PnL in bps of `close` against the entry reference close. */
function pnlBps(close: bigint, ref: bigint): bigint {
  return ((close - ref) * 10_000n) / ref;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') entries += 1;
    }
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      if (refClose === null) {
        refClose = close;
        peakBps = 0n;
      }
      const pnl = pnlBps(close, refClose);
      if (pnl > peakBps) peakBps = pnl;
      const stopped = pnl <= -STOP_BPS;
      const trailed = peakBps >= TRAIL_ARM_BPS && peakBps - pnl >= TRAIL_BPS;
      if (stopped || trailed) {
        if (pnl < 0n) lastLossSeq = state.seq;
        refClose = null;
        peakBps = 0n;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    refClose = null;
    peakBps = 0n;
    if (closes.length < HISTORY_BARS) return [];
    if (entries >= MAX_ENTRIES) return [];
    if (state.seq - lastLossSeq < COOLDOWN_BARS) return [];
    const back = closes[closes.length - 1 - MOMENTUM_BARS];
    if (back === undefined) return [];
    if (pnlBps(close, back) < 0n) return [];

    let slice = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (slice > room) slice = room;
    if (slice <= 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    refClose = close;
    peakBps = 0n;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
