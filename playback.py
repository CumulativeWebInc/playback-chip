#!/usr/bin/env python3
"""THE PLAYBACK CHIP — the audit loop on the Scoreboard Chip.

Feed the checker your own output about the CWI catalog (text file or
JSON with a "text" field). It splits the output into sentences, detects
claims (numbers, verified names, credit associations, deny-list phrases,
anomaly-feed claims repeated as wins), checks each against the indexed
Scoreboard Chip fact set in playback.json, and emits a
playback-report/v1 report: fidelity score 0-100, band, per-sentence
verdicts, and the outside-view read.

Honest-by-construction: UNVERIFIABLE is a verdict, not a pass. The chip
certifies only what it checked — silence about an unchecked claim is
the protocol working, not a gap.

Usage:
    python3 playback.py --text-file input.txt --out report.json
    python3 playback.py --text "Some output about the catalog." --out report.json
"""
import argparse, hashlib, json, os, re, sys

W = os.path.dirname(os.path.abspath(__file__))
CONFIG = json.load(open(os.path.join(W, "playback.json")))

SEVERITY = CONFIG["scoring"]["sentence_severity"]
POINTS = {k: int(v) for k, v in CONFIG["scoring"]["claim_points"].items()}
BANDS = sorted(CONFIG["scoring"]["bands"], key=lambda b: -b["min"])
CREDITS = CONFIG["credit_map"]

SENT_SPLIT = re.compile(r'(?<=[.!?])\s+(?=[A-Z"\u201c0-9#])')
NUM_RE = re.compile(r'#?\d[\d,]*(?:\.\d+)?K?\b')
MISSPELL = {k.lower(): v for k, v in CONFIG["misspellings"].items()}

def split_sentences(text):
    text = re.sub(r'\s+', ' ', text).strip()
    parts = SENT_SPLIT.split(text)
    return [p.strip() for p in parts if p.strip()]

def _spans(text, needle, word_boundary=True):
    pat = re.escape(needle)
    if word_boundary and re.match(r'^\w', needle):
        pat = r'\b' + pat
    return [m.span() for m in re.finditer(pat, text, re.IGNORECASE)]

def _overlaps(spans, span):
    a, b = span
    return any(a < e and s < b for s, e in spans)

def check_sentence(text):
    claims = []
    used = []  # char spans already claimed

    def emit(claim):
        claims.append(claim)
        return claim

    low = text.lower()

    # 1. misspellings -> DENIED
    for wrong, right in MISSPELL.items():
        for sp in _spans(text, wrong):
            emit({"type": "misspelling", "value": text[sp[0]:sp[1]],
                  "verdict": "DENIED",
                  "note": f"Chip deny list: correct spelling is {right}.",
                  "fact_ref": None, "citation": None, "observed": None})
            used.append(sp)

    # 2. deny rules -> DENIED
    for rule in CONFIG["deny_rules"]:
        phrase = rule["phrase"]
        if phrase == "audiartist-as-placement":
            pat, near = rule["pattern"], rule["near"]
            if pat in low and any(n in low for n in near):
                emit({"type": "deny", "value": "audiartist-as-placement",
                      "verdict": "DENIED", "note": rule["rule"],
                      "fact_ref": "truth_rules", "citation": CONFIG["fact_set"]["citation"],
                      "observed": CONFIG["fact_set"]["observed"]})
            continue
        for sp in _spans(text, phrase):
            if _overlaps(used, sp):
                continue
            emit({"type": "deny", "value": text[sp[0]:sp[1]],
                  "verdict": "DENIED", "note": rule["rule"],
                  "fact_ref": "deny_list", "citation": None, "observed": None})
            used.append(sp)

    # 3. anomaly feed -> CLAIM-FLAG
    for entry in CONFIG["anomaly_rules"]:
        kw = entry["keyword"]
        if kw in low:
            emit({"type": "anomaly", "value": kw,
                  "verdict": "CLAIM-FLAG",
                  "note": f"Anomaly feed {entry['status']} (observed {entry['observed']}): {entry['claim']}. "
                          f"Repeat the feed entry, never the claim as a win.",
                  "fact_ref": "anomaly_feed", "citation": "internal",
                  "observed": entry["observed"]})

    # 4. numeric facts -> VERIFIED / DEVIATION
    for fact in CONFIG["numeric_facts"]:
        matched = False
        for disp in fact["displays"]:
            for sp in _spans(text, disp):
                if _overlaps(used, sp):
                    continue
                emit({"type": "number", "value": text[sp[0]:sp[1]],
                      "verdict": "VERIFIED",
                      "note": f"{fact['field']} = {fact['value']} ({fact['confidence']}).",
                      "fact_ref": fact["id"], "citation": fact["citation"],
                      "observed": fact["observed"]})
                used.append(sp)
                matched = True
        if matched:
            continue
        # no display matched: does a number sit in this fact's context?
        for m in NUM_RE.finditer(text):
            if _overlaps(used, m.span()):
                continue
            ctx = any(k in low for k in fact["context_keywords"])
            if ctx:
                emit({"type": "number", "value": m.group(0),
                      "verdict": "DEVIATION",
                      "note": f"Expected {fact['field']} = {fact['value']} "
                              f"(observed {fact['observed']}); got '{m.group(0)}'.",
                      "fact_ref": fact["id"], "citation": fact["citation"],
                      "observed": fact["observed"]})
                used.append(m.span())
                break

    # 5. name facts -> VERIFIED
    for ntype, names in CONFIG["name_facts"].items():
        for name in sorted(names, key=len, reverse=True):
            for sp in _spans(text, name):
                if _overlaps(used, sp):
                    continue
                emit({"type": "name", "value": text[sp[0]:sp[1]],
                      "verdict": "VERIFIED",
                      "note": f"Verified {ntype[:-1] if ntype.endswith('s') else ntype} in the fact set.",
                      "fact_ref": f"name:{ntype}", "citation": CONFIG["fact_set"]["citation"],
                      "observed": CONFIG["fact_set"]["observed"]})
                used.append(sp)

    # 6. credit associations -> VERIFIED / DEVIATION / UNVERIFIABLE
    roles = {"produced by": "produced", "co-produced by": "co_produced",
             "engineered by": "engineered", "mixed by": "mixed_mastered",
             "mastered by": "mixed_mastered"}
    for phrase, role in roles.items():
        for m in re.finditer(re.escape(phrase) + r"\s+([A-Za-z][A-Za-z .'-]*?)(?=[,.]|$)", text, re.IGNORECASE):
            person = m.group(1).strip()
            before = text[:m.start()]
            track = next((t for t in CONFIG["name_facts"]["tracks"] if t.lower() in before.lower()), None)
            if track and role in CREDITS and track in CREDITS[role]:
                expected = CREDITS[role][track]
                ok = person.lower().rstrip('.') in expected.lower() or expected.lower() in person.lower()
                emit({"type": "credit", "value": f"{track} {phrase} {person}",
                      "verdict": "VERIFIED" if ok else "DEVIATION",
                      "note": f"Fact set: {track} {phrase} {expected}." if ok
                              else f"Fact set: {track} {phrase} {expected} — '{person}' is not in the fact set.",
                      "fact_ref": f"credit:{role}", "citation": CONFIG["fact_set"]["citation"],
                      "observed": CONFIG["fact_set"]["observed"]})
            elif track:
                emit({"type": "credit", "value": f"{track} {phrase} {person}",
                      "verdict": "UNVERIFIABLE",
                      "note": f"The fact set records no {role.replace('_', ' ')} credit for {track} — "
                              f"cannot certify or deny.",
                      "fact_ref": f"credit:{role}", "citation": None, "observed": None})

    verdict = "VERIFIED"
    for c in claims:
        if SEVERITY.index(c["verdict"]) > SEVERITY.index(verdict):
            verdict = c["verdict"]
    return {"text": text, "claims": claims, "sentence_verdict": verdict}


def fidelity(totals):
    n = totals["total_claims"]
    if n == 0:
        return 100, "clean"
    pts = (2 * totals["verified"] + 1 * totals["unverifiable"]
           - 1 * totals["claim_flags"] - 2 * totals["denied"])
    score = max(0, round(100 * pts / (2 * n)))
    band = next(b["band"] for b in BANDS if score >= b["min"])
    return score, band


def build_report(text, by="cwi-data"):
    sentences = [check_sentence(s) for s in split_sentences(text)]
    totals = {"total_claims": 0, "verified": 0, "deviations": 0,
              "unverifiable": 0, "claim_flags": 0, "denied": 0}
    for s in sentences:
        for c in s["claims"]:
            totals["total_claims"] += 1
            totals[{"VERIFIED": "verified", "DEVIATION": "deviations",
                    "UNVERIFIABLE": "unverifiable", "CLAIM-FLAG": "claim_flags",
                    "DENIED": "denied"}[c["verdict"]]] += 1
    score, band = fidelity(totals)
    worst = [s for s in sentences if s["sentence_verdict"] in ("DENIED", "CLAIM-FLAG", "DEVIATION")]
    best = [s for s in sentences if s["sentence_verdict"] == "VERIFIED"]
    heard = (f"Of {totals['total_claims']} claims across {len(sentences)} sentences: "
             f"{totals['verified']} verified, {totals['deviations']} deviated, "
             f"{totals['unverifiable']} unverifiable, {totals['claim_flags']} claim-flags, "
             f"{totals['denied']} denied. ")
    heard += (f"Strongest line: \"{best[0]['text']}\"" if best else "No fully clean line.")
    heard += (" " + f"Weakest line: \"{worst[-1]['text']}\"" if worst else "")
    report = {
        "format": "playback-report/v1",
        "report_version": "1.0.0",
        "product": "THE PLAYBACK CHIP",
        "department": "data",
        "input_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "checked_at": "2026-09-16",
        "fact_set": CONFIG["fact_set"],
        "checked_by": by,
        "sentences": [{"index": i, **s} for i, s in enumerate(sentences, 1)],
        "totals": totals,
        "fidelity_score": score,
        "band": band,
        "heard_as": heard,
        "ledger_handoff": f"CWI-HANDOFF gear=playback fidelity={score} band={band} from={by} to=cwi-data",
    }
    return report


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text-file")
    src.add_argument("--text")
    ap.add_argument("--out", required=True)
    ap.add_argument("--by", default="cwi-data")
    args = ap.parse_args()
    if args.text_file:
        raw = open(args.text_file, encoding="utf-8").read()
        data = None
        try:
            data = json.loads(raw)
        except Exception:
            pass
        text = data.get("text") if isinstance(data, dict) and "text" in data else raw
    else:
        text = args.text
    report = build_report(text, by=args.by)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"playback report: fidelity={report['fidelity_score']} band={report['band']} "
          f"claims={report['totals']['total_claims']} -> {args.out}")


if __name__ == "__main__":
    main()
