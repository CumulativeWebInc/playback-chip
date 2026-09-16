# THE PLAYBACK CHIP

The audit loop on the CWI-1 Scoreboard Chip — Data Department, CWI gear #26.

**Live app:** https://cumulativewebinc.github.io/playback-chip/

An agent pastes its own output about the CWI catalog and gets back a scored, annotated playback: every detected claim checked against the verified fact set, returned with a fidelity score (0–100), per-sentence verdicts, and the exact line that sank or sailed each claim — like a tape machine's playback head checking what was just recorded.

## How it works

1. **Feed** — paste text (or JSON with a `text` field): anything you were about to publish about the catalog.
2. **Detect** — the chip splits it into sentences and detects claims: numbers, verified names, credit associations, deny-list phrases, anomaly-feed claims repeated as wins.
3. **Check** — each claim is annotated: `VERIFIED` (with citation + observed date), `DEVIATION` (with the expected value), `UNVERIFIABLE` (fact set is silent), `CLAIM-FLAG` (anomaly-feed entry repeated as fact), `DENIED` (deny-list rule fired).
4. **Score** — fidelity 0–100, banded `clean / notes / rewrites-needed / don't-ship`, plus the one-paragraph outside view: how your output reads to someone checking your work.

## Truth labels

- **Fact set: LIVE** — `playback.json` is the indexed Scoreboard Chip fact set, observed 2026-09-15, with per-claim citations.
- **Demo inputs: SAMPLE** — the two "Load SAMPLE" buttons inject simulated demo text, honestly labeled in the UI. Never presented as real.
- **Honesty rule:** UNVERIFIABLE is a verdict, not a pass. The chip certifies only what it checked — silence about an unchecked claim is the protocol working, not a gap.

## Files

| File | What it is |
|---|---|
| `index.html` | The web app (all client-side, no server, no tracking) |
| `playback.js` | Engine — JS port of `playback.py`, parity-tested |
| `playback.py` | Engine source (Python, v1.0.0, from the gear-line prototype) |
| `playback.json` | The LIVE fact set (`cwi-playback/v1`) |
| `playback-schema.json` | JSON Schema for the config and the `playback-report/v1` report |
| `tests/test-parity.js` | Parity suite: 21 inputs, JS engine vs Python engine must agree claim-by-claim |
| `assets/logo.jpg` | Official CWI logo |

## Tests

```bash
node tests/test-parity.js   # requires node; compares JS engine vs playback.py on 21 cases + sha256
```

White-label: equip it, re-skin it, ship it in your own stack. No pricing, no accounts, no telemetry.

Contact: hp@cumulativeweb.com · © Cumulative Web Inc
