#!/usr/bin/env node
/* Parity test: playback.js (JS) vs playback.py (Python). Fails loudly on any mismatch. */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, ".."); /* repo root: playback.js/json/py live here */
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, "playback.json"), "utf8"));
const { makeEngine, sha256 } = require(path.join(DIR, "playback.js"));
const engine = makeEngine(CONFIG);

const CASES = [
  "Zooted Zone has 307,439 lifetime Spotify plays.",
  "That Boy Hi Hat is based in Frederick, Maryland.",
  "Zooted Zone was produced by Kokurcho.",
  "Flamerz was produced by Jeck Da General.",
  "Diabolique was recorded at Cue Recording Studio, Arlington, Virginia.",
  "Zooted Zone has 400,000 streams and counting.",
  "King Ahkeem released a new track with infinite reach.",
  "Flow said Zooted Zone was added to No Label Needed.",
  "The track has 132,000 plays according to some site.",
  "The Audiartist campaign #25818 was accepted as a playlist placement.",
  "The catalog has 24 tracks and 171 monthly listeners.",
  "Shaka Zulu sits at #21 on New Rap Hits.",
  "Diabolique was produced by Hybrid and co-produced by Black Lansky.",
  "Diabolique was engineered by Blaine Misner.",
  "Zooted Zone was mixed by Hybrid.",
  "The 12 languages rollout is live.",
  "Zooted Zone was produced by Someone Else.",
  "Star by King Akeem has 112,510 plays.",
  "Hello world. This is a test with no claims.",
  "Zooted Zone hit 260k streams in a week and is streaming fast.",
  "Every language is covered by the new release."
];

function pyReport(text) {
  const tmp = path.join(DIR, ".parity-in.txt");
  fs.writeFileSync(tmp, text, "utf8");
  const PY = process.env.PLAYBACK_PY ||
    path.join(DIR, "playback.py"); /* repo copy: byte-identical to the gear-line original */
  execFileSync("python3", [PY, "--text-file", tmp, "--out", "/tmp/parity-out.json", "--by", "parity-test"]);
  const rep = JSON.parse(fs.readFileSync("/tmp/parity-out.json", "utf8"));
  fs.unlinkSync(tmp);
  return rep;
}

function norm(r) {
  // strip fields that legitimately differ (checked_at date impl, input hash covered separately)
  return {
    fidelity_score: r.fidelity_score,
    band: r.band,
    totals: r.totals,
    heard_as: r.heard_as,
    sentences: r.sentences.map(s => ({
      text: s.text, sentence_verdict: s.sentence_verdict,
      claims: s.claims.map(c => ({
        type: c.type, value: c.value, verdict: c.verdict, note: c.note,
        fact_ref: c.fact_ref, citation: c.citation, observed: c.observed
      }))
    }))
  };
}

let fails = 0;
CASES.forEach((text, i) => {
  const js = norm(engine.buildReport(text, "parity-test"));
  const py = norm(pyReport(text));
  const a = JSON.stringify(js), b = JSON.stringify(py);
  if (a !== b) {
    fails++;
    console.log(`\nMISMATCH case ${i}: ${JSON.stringify(text)}`);
    // show first diff
    for (let k = 0; k < Math.max(a.length, b.length); k++) {
      if (a[k] !== b[k]) {
        console.log("  js: ..." + a.slice(Math.max(0, k - 80), k + 120));
        console.log("  py: ..." + b.slice(Math.max(0, k - 80), k + 120));
        break;
      }
    }
  } else {
    console.log(`ok   case ${i}: score=${js.fidelity_score} band=${js.band} claims=${js.totals.total_claims}`);
  }
});

// sha256 cross-check vs python hashlib
const sample = "Zooted Zone — 307,439 plays ✓";
fs.writeFileSync("/tmp/parity-hash.txt", sample, "utf8");
const pyHash2 = execFileSync("python3", ["-c",
  "import hashlib;print(hashlib.sha256(open('/tmp/parity-hash.txt','rb').read()).hexdigest())"], { encoding: "utf8" }).trim();
const jsHash = sha256(unescape(encodeURIComponent(sample)));
console.log(jsHash === pyHash2 ? "ok   sha256 parity" : `MISMATCH sha256: js=${jsHash} py=${pyHash2}`);
if (jsHash !== pyHash2) fails++;

console.log(fails === 0 ? "\nALL PARITY TESTS PASSED" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
