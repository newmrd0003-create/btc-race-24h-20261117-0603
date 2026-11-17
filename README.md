# Patient Momentum Rider — make.fun btc-race-24h-20261117-0603 entry

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/newmrd0003-create/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/newmrd0003-create/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A long-only cbBTC/USDC 1-minute trading bot for the [make.fun bounty](https://make.fun/bounty/btc-race-24h-20261117-0603): race a BTC trading bot live for 24 hours on real on-chain DEX prices (Orca Whirlpool cbBTC/USDC), paper money, ranked by net PnL.

## The idea

On a 1-minute chart the noise is ~12 bps a minute while a full-size round trip costs ~26–36 bps in fee, slippage and own price impact. A bot that trades every wiggle pays the market for the privilege of churning — so this bot trades rarely, and only after the tape has had time to say something.

- **Wait 240 bars (4 hours)** before the first entry. The first hours of a 24-hour window are chop more often than trend.
- **Entry, full size, max 3 per run:** the close is above its close 24 bars ago (24-bar momentum ≥ 0). If the last 24 minutes netted up, ride it.
- **Exits, whole position, no exceptions:** hard stop 100 bps under the close that triggered the entry; trailing stop 70 bps once the position has peaked 80 bps above that close. A 60-bar cooldown follows any losing exit.

## Dev result (verified)

`makefun grade-local --kit <kit> --bot . --driver process`:

- **Net PnL +15.41 USDC** — clears the dev gate (PnL > 0), so the bot races
- 5 filled orders, max drawdown 1.36% (limit 25%), Sharpe 0.019, fees 2.42 USDC
- Deterministic: two executions reproduce byte for byte (`l1.reproduced: true`)
- Kit baselines on the same window: buy-and-hold +1.07, momentum +2.45, ema-cross −106.21, rsi-bollinger −24.25, adx-momentum −32.66 USDC
- The trailing-stop plateau is broad (trail 70–90 bps all clear the gate), not a knife-edge optimum

## Risk controls

- At most 1 open position, full-size buy only, never more than cash on hand
- Stop-loss + trailing stop on every position, no exceptions
- `max_slippage_bps` 100 on every order (1% past the deciding close)
- No orders while warming up; sells sent before buys
- Max 3 entries per run, 60-bar cooldown after a losing exit

## Layout

- `main.ts` — the bot (TypeScript, erasable syntax, stdlib only via the SDK shim)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK (`sdk/makefun-bars.ts`)

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --json
```

Deterministic by construction: bigint integer math on bar closes and the harness-reported account only, no clock, no environment, no randomness. The bot is a pure function of the bars it has seen.

## License

MIT — see [LICENSE](LICENSE).
