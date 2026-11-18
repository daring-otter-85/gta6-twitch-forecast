# Method: forecasting GTA VI's launch-day Twitch viewers, hour by hour

## The task

For Grand Theft Auto VI's release day (2026-11-19, UTC), forecast the Twitch
category's concurrent viewers for each hour 2–24 of the day, as five quantiles
(5/25/50/75/95%), given everything recorded up to the end of hour 1 — that
hour's count included. Scoring is the mean pinball loss on the log scale over
every hour and quantile, so the forecast must be right in *ratio* terms at
every scale, and the spread must be honest: too narrow pays for every hour
outside it, too wide pays at every hour.

The program (`main.ts`) runs offline in the grader's sandbox, one case at a
time, in well under a second. Everything it knows is in the case file: the
game's own pre-launch hourly history, hour 1's print, a notes field, and a
library of **comparables** — past launches with their full hourly curves
around release (release −14 days to +3 days), their platforms and a researched
unlock description for each. All viewer counts are SullyGnome's hourly Twitch
category averages, quoted with attribution (see the kit's `input/NOTICE.txt`).

## The one fact that shapes the day: how the game unlocks

Reading the comparables' launch days (viewers in the category, UTC hours)
shows three archetypes, set by the unlock pattern:

- **Rolling midnight local** (consoles unlock at local midnight, region by
  region): hour 1 holds only New Zealand/Australia/Japan and early risers —
  the game has been playable since 11:00Z the day before — and the audience
  *builds all day* to a US prime-time peak around hours 18–24. Red Dead
  Redemption 2 went 116,550 in hour 1 → 369,358 at hour 18; God of War
  Ragnarök 269,517 → 460,387 at hour 20; Marvel's Spider-Man 2 119,087 →
  263,140 at hour 22; Marvel's Wolverine 23,357 → 212,243 at hour 21.
- **Fixed-hour global unlock**: hour 1 is pre-launch baseline (near zero) and
  the curve ramps vertically at the unlock hour — Hollow Knight: Silksong
  (14:00Z unlock) printed 164 in hour 1 and peaked at 347,773; Baldur's Gate 3
  printed 3,447 in hour 1 on its way to 462,928; Black Myth: Wukong (02:00Z
  unlock) printed 4,941 in hour 1 and peaked at 454,807.
- **Early access / front-loaded**: hour 1 is already at or near the day's peak
  and the day decays — ELDEN RING printed its peak 875,155 in hour 1
  (PC global unlock 23:00Z the previous day), Cyberpunk 2077 851,999 in hour 1
  (midnight GMT PC launch), Diablo IV 533,455 in hour 1 after days of early
  access.

GTA VI is in the first class, on every source: Rockstar and PlayStation
describe a rolling midnight-local launch by country, New Zealand first at
11:00 UTC on 2026-11-18, the US store at midnight Eastern (05:00Z), pre-load
from 2026-11-10, and **no early access on any edition** (Rockstar Support;
PlayStation Blog, 2026-11-10; the kit's own GTA VI comparable note says the
same). So hour 1 of 2026-11-19 will already contain thirteen hours of
Asia-Pacific play, and the day should build toward a late-day peak — but the
program does not hard-code this: it reads the class from the case's notes at
run time, so the same code would forecast a global-unlock launch correctly.

Two more scale facts from the case data: the GTA VI category existed before
launch (Twitch id 1867279146) and drew 37,647 viewers in its first recorded
hour (2026-08-27T17:00Z, the Netflix extended-look premiere) — pre-launch
attention an order of magnitude above a normal category — and Rockstar's
previous launch, RDR2, is the closest structural analogue (same studio, same
rolling console launch; in the final case it is among the comparables).

## The model

Everything below is computed from the case file at run time; nothing is
fitted to the target by hand.

1. **Ratio curves.** Each comparable with a usable launch day (hour 1 sampled
   and positive, ≥20 of the day's 24 hours sampled) becomes a log-ratio curve
   `r_c(h) = ln V_c(h) − ln V_c(1)` for h = 2..24, plus three features:
   its **curve class** (late / build / front, from hour 1 as a share of the
   day's peak), its **hour-1 scale**, and its **pre-launch ramp**
   `u = ln(mean viewers of hours −6..−1 / hour 1)` — for a rolling launch
   those six hours are the Asia-Pacific wave already playing, so `u` says how
   far along the wave the day starts.
2. **Target features.** The same scale and ramp are read from the case (its
   history and hour 1), and its wanted curve class from its notes
   (rolling → build; global-only → late; rolling + global → front).
3. **Weights.** Each comparable is weighted by class match (1 / 0.45 / 0.08
   for distance 0 / 1 / 2), a Gaussian kernel on scale distance
   (σ = 0.7 in log viewers), a Gaussian kernel on ramp distance (σ = 0.5),
   recency (weight halves every 10 years), and a 0.45 factor on
   early-access-contaminated comparables when the target has none.
4. **Quantiles.** Each hour's location is the weighted median of the
   comparables' log-ratios at that hour. Its spread is the weighted MAD of
   those ratios (×1.4826), floored at 0.22 and capped at 1.15 in log units and
   smoothed over ±2 hours. The five quantiles blend the weighted *empirical*
   quantiles of the ratios (weight 0.45) with the normal curve at that spread
   (weight 0.55), are multiplied by hour 1's print, rounded to 2 decimals and
   sorted. If a case ever carried fewer than five usable comparables, the
   program falls back to the house persistence shape rather than fail.

## Validation (all offline, before submission)

- **Practice launches.** The kit ships four practice cases (Wolverine, RDR2,
  God of War Ragnarök, Spider-Man 2 — all rolling-midnight launches, the
  target's own class). Scoring this program against those launches' actual
  SullyGnome hours: **mean log-pinball 0.196**, against 0.387 for the house
  persistence baseline — the same 0.387 the rules quote for the baseline on
  the practice set, which pins the comparison down.
- **Leave-one-out over the comparables.** Each of the 37 launches with a full
  day was forecast from the other 36: **0.483** against the baseline's 0.930;
  restricted to rolling-midnight targets, **0.275**.
- The tuning surface around the chosen constants is flat (practice loss
  0.195–0.199 across the plausible grid), so the constants are mid-range
  choices, not a fit to four data points; a self-correcting variant that
  re-forecast its own top comparables and adjusted was tested and *rejected*
  — it scored worse at every strength.
- Output contract checked mechanically on all four practice cases: exactly
  23 rows (hours 2–24), five finite quantiles in (0, 1e9], non-decreasing,
  ≤65,536 bytes; two consecutive runs byte-identical; ~0.1 s per case against
  the sandbox's 8 s cap.

## What would make this forecast wrong

The honest risks: GTA VI is bigger than every comparable, so if its US
prime-time wave saturates differently (e.g. Twitch-wide records pulling in
non-game viewers), the late hours could run above the analogues' ratios; a
day-one outage or a delayed store unlock in a major region would bend the
ramp the other way. The quantile spread (σ ≈ 0.3–0.6 in log units by hour 20)
is priced for exactly that disagreement among the analogues.
