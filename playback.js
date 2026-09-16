/* THE PLAYBACK CHIP — engine (JS port of playback.py, engine v1.0.0).
 *
 * Feed it output about the CWI catalog. It splits the output into
 * sentences, detects claims (numbers, verified names, credit
 * associations, deny-list phrases, anomaly-feed claims repeated as
 * wins), checks each against the indexed Scoreboard Chip fact set,
 * and emits a playback-report/v1 report: fidelity score 0-100, band,
 * per-sentence verdicts, and the outside-view read.
 *
 * Honest-by-construction: UNVERIFIABLE is a verdict, not a pass.
 *
 * Works in the browser (window.PlaybackChip) and Node (module.exports).
 * CONFIG is injected at build time from playback.json (the LIVE fact set).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlaybackChip = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- compact synchronous SHA-256 ---------- */
  function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32), i, j, result = "";
    var words = [], asciiBitLength = ascii.length * 8;
    var hash = (sha256.h = sha256.h || []), k = (sha256.k = sha256.k || []);
    var primeCounter = k.length, isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while ((ascii.length % 64) - 56) ascii += "\x00";
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return ""; // ASCII check
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, (j += 16)), oldHash = hash.slice(0, 8);
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 =
          (hash[7] +
            (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) +
            ((e & hash[5]) ^ (~e & hash[6])) +
            k[i] +
            (w[i] =
              i < 16
                ? w[i]
                : (w[i - 16] +
                    (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) +
                    w[i - 7] +
                    (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) |
                  0)) |
          0;
        var temp2 =
          (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++)
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? "0" : "") + b.toString(16);
      }
    return result;
  }

  function utf8Bytes(str) {
    return unescape(encodeURIComponent(str));
  }

  /* ---------- engine ---------- */
  function makeEngine(CONFIG) {
    var SEVERITY = CONFIG.scoring.sentence_severity;
    var POINTS = {};
    Object.keys(CONFIG.scoring.claim_points).forEach(function (k) {
      POINTS[k] = parseInt(CONFIG.scoring.claim_points[k], 10);
    });
    var BANDS = CONFIG.scoring.bands
      .slice()
      .sort(function (a, b) { return b.min - a.min; });
    var CREDITS = CONFIG.credit_map;
    var MISSPELL = {};
    Object.keys(CONFIG.misspellings).forEach(function (k) {
      MISSPELL[k.toLowerCase()] = CONFIG.misspellings[k];
    });

    var SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z"“0-9#])/g;
    var NUM_RE = /#?\d[\d,]*(?:\.\d+)?K?\b/g;

    function escapeRegExp(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function spans(text, needle, wordBoundary) {
      wordBoundary = wordBoundary === undefined ? true : wordBoundary;
      var pat = escapeRegExp(needle);
      if (wordBoundary && /^\w/.test(needle)) pat = "\\b" + pat;
      var re = new RegExp(pat, "gi"), out = [], m;
      while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
      return out;
    }

    function overlaps(usedSpans, span) {
      var a = span[0], b = span[1];
      return usedSpans.some(function (s) { return a < s[1] && s[0] < b; });
    }

    function splitSentences(text) {
      text = text.replace(/\s+/g, " ").trim();
      if (!text) return [];
      SENT_SPLIT.lastIndex = 0;
      return text.split(SENT_SPLIT).map(function (p) { return p.trim(); }).filter(Boolean);
    }

    function checkSentence(text) {
      var claims = [], used = [];
      var low = text.toLowerCase();

      function emit(claim) { claims.push(claim); return claim; }

      // 1. misspellings -> DENIED
      Object.keys(MISSPELL).forEach(function (wrong) {
        spans(text, wrong).forEach(function (sp) {
          emit({
            type: "misspelling", value: text.slice(sp[0], sp[1]), verdict: "DENIED",
            note: "Chip deny list: correct spelling is " + MISSPELL[wrong] + ".",
            fact_ref: null, citation: null, observed: null
          });
          used.push(sp);
        });
      });

      // 2. deny rules -> DENIED
      CONFIG.deny_rules.forEach(function (rule) {
        var phrase = rule.phrase;
        if (phrase === "audiartist-as-placement") {
          if (rule.pattern && low.indexOf(rule.pattern) !== -1 &&
              rule.near.some(function (n) { return low.indexOf(n) !== -1; })) {
            emit({
              type: "deny", value: "audiartist-as-placement", verdict: "DENIED",
              note: rule.rule, fact_ref: "truth_rules",
              citation: CONFIG.fact_set.citation, observed: CONFIG.fact_set.observed
            });
          }
          return;
        }
        spans(text, phrase).forEach(function (sp) {
          if (overlaps(used, sp)) return;
          emit({
            type: "deny", value: text.slice(sp[0], sp[1]), verdict: "DENIED",
            note: rule.rule, fact_ref: "deny_list", citation: null, observed: null
          });
          used.push(sp);
        });
      });

      // 3. anomaly feed -> CLAIM-FLAG
      CONFIG.anomaly_rules.forEach(function (entry) {
        if (low.indexOf(entry.keyword) !== -1) {
          emit({
            type: "anomaly", value: entry.keyword, verdict: "CLAIM-FLAG",
            note: "Anomaly feed " + entry.status + " (observed " + entry.observed + "): " +
              entry.claim + ". Repeat the feed entry, never the claim as a win.",
            fact_ref: "anomaly_feed", citation: "internal", observed: entry.observed
          });
        }
      });

      // 4. numeric facts -> VERIFIED / DEVIATION
      CONFIG.numeric_facts.forEach(function (fact) {
        var matched = false;
        fact.displays.forEach(function (disp) {
          spans(text, disp).forEach(function (sp) {
            if (overlaps(used, sp)) return;
            emit({
              type: "number", value: text.slice(sp[0], sp[1]), verdict: "VERIFIED",
              note: fact.field + " = " + fact.value + " (" + fact.confidence + ").",
              fact_ref: fact.id, citation: fact.citation, observed: fact.observed
            });
            used.push(sp);
            matched = true;
          });
        });
        if (matched) return;
        NUM_RE.lastIndex = 0;
        var m;
        while ((m = NUM_RE.exec(text)) !== null) {
          var sp = [m.index, m.index + m[0].length];
          if (overlaps(used, sp)) continue;
          var ctx = fact.context_keywords.some(function (k) { return low.indexOf(k) !== -1; });
          if (ctx) {
            emit({
              type: "number", value: m[0], verdict: "DEVIATION",
              note: "Expected " + fact.field + " = " + fact.value +
                " (observed " + fact.observed + "); got '" + m[0] + "'.",
              fact_ref: fact.id, citation: fact.citation, observed: fact.observed
            });
            used.push(sp);
            break;
          }
        }
      });

      // 5. name facts -> VERIFIED
      Object.keys(CONFIG.name_facts).forEach(function (ntype) {
        CONFIG.name_facts[ntype]
          .slice()
          .sort(function (a, b) { return b.length - a.length; })
          .forEach(function (name) {
            spans(text, name).forEach(function (sp) {
              if (overlaps(used, sp)) return;
              var singular = ntype.endsWith("s") ? ntype.slice(0, -1) : ntype;
              emit({
                type: "name", value: text.slice(sp[0], sp[1]), verdict: "VERIFIED",
                note: "Verified " + singular + " in the fact set.",
                fact_ref: "name:" + ntype,
                citation: CONFIG.fact_set.citation, observed: CONFIG.fact_set.observed
              });
              used.push(sp);
            });
          });
      });

      // 6. credit associations -> VERIFIED / DEVIATION / UNVERIFIABLE
      var roles = {
        "produced by": "produced",
        "co-produced by": "co_produced",
        "engineered by": "engineered",
        "mixed by": "mixed_mastered",
        "mastered by": "mixed_mastered"
      };
      Object.keys(roles).forEach(function (phrase) {
        var role = roles[phrase];
        var re = new RegExp(escapeRegExp(phrase) + "\\s+([A-Za-z][A-Za-z .'-]*?)(?=[,.]|$)", "gi");
        var m;
        while ((m = re.exec(text)) !== null) {
          var person = m[1].trim();
          var before = text.slice(0, m.index);
          var blow = before.toLowerCase();
          var track = null;
          for (var i = 0; i < CONFIG.name_facts.tracks.length; i++) {
            if (blow.indexOf(CONFIG.name_facts.tracks[i].toLowerCase()) !== -1) {
              track = CONFIG.name_facts.tracks[i];
              break;
            }
          }
          if (track && CREDITS[role] && CREDITS[role][track]) {
            var expected = CREDITS[role][track];
            var pl = person.toLowerCase().replace(/\.+$/, ""), el = expected.toLowerCase();
            var ok = pl.indexOf(el) !== -1 || el.indexOf(pl) !== -1;
            emit({
              type: "credit",
              value: track + " " + phrase + " " + person,
              verdict: ok ? "VERIFIED" : "DEVIATION",
              note: ok
                ? "Fact set: " + track + " " + phrase + " " + expected + "."
                : "Fact set: " + track + " " + phrase + " " + expected +
                  " — '" + person + "' is not in the fact set.",
              fact_ref: "credit:" + role,
              citation: CONFIG.fact_set.citation, observed: CONFIG.fact_set.observed
            });
          } else if (track) {
            emit({
              type: "credit",
              value: track + " " + phrase + " " + person,
              verdict: "UNVERIFIABLE",
              note: "The fact set records no " + role.replace(/_/g, " ") +
                " credit for " + track + " — cannot certify or deny.",
              fact_ref: "credit:" + role, citation: null, observed: null
            });
          }
        }
      });

      var verdict = "VERIFIED";
      claims.forEach(function (c) {
        if (SEVERITY.indexOf(c.verdict) > SEVERITY.indexOf(verdict)) verdict = c.verdict;
      });
      return { text: text, claims: claims, sentence_verdict: verdict };
    }

    function fidelity(totals) {
      var n = totals.total_claims;
      if (n === 0) return [100, "clean"];
      var pts =
        2 * totals.verified +
        1 * totals.unverifiable -
        1 * totals.claim_flags -
        2 * totals.denied;
      var score = Math.max(0, Math.round((100 * pts) / (2 * n)));
      var band = BANDS.filter(function (b) { return score >= b.min; })[0].band;
      return [score, band];
    }

    function buildReport(text, by) {
      by = by || "cwi-data";
      var sentences = splitSentences(text).map(checkSentence);
      var totals = {
        total_claims: 0, verified: 0, deviations: 0,
        unverifiable: 0, claim_flags: 0, denied: 0
      };
      var key = {
        VERIFIED: "verified", DEVIATION: "deviations",
        UNVERIFIABLE: "unverifiable", "CLAIM-FLAG": "claim_flags", DENIED: "denied"
      };
      sentences.forEach(function (s) {
        s.claims.forEach(function (c) {
          totals.total_claims += 1;
          totals[key[c.verdict]] += 1;
        });
      });
      var fb = fidelity(totals);
      var score = fb[0], band = fb[1];
      var worst = sentences.filter(function (s) {
        return ["DENIED", "CLAIM-FLAG", "DEVIATION"].indexOf(s.sentence_verdict) !== -1;
      });
      var best = sentences.filter(function (s) { return s.sentence_verdict === "VERIFIED"; });
      var heard =
        "Of " + totals.total_claims + " claims across " + sentences.length + " sentences: " +
        totals.verified + " verified, " + totals.deviations + " deviated, " +
        totals.unverifiable + " unverifiable, " + totals.claim_flags + " claim-flags, " +
        totals.denied + " denied. ";
      heard += best.length ? 'Strongest line: "' + best[0].text + '"' : "No fully clean line.";
      if (worst.length) heard += ' Weakest line: "' + worst[worst.length - 1].text + '"';
      var today = new Date().toISOString().slice(0, 10);
      return {
        format: "playback-report/v1",
        report_version: "1.0.0",
        product: "THE PLAYBACK CHIP",
        department: "data",
        input_sha256: sha256(utf8Bytes(text)),
        checked_at: today,
        fact_set: CONFIG.fact_set,
        checked_by: by,
        sentences: sentences.map(function (s, i) {
          return { index: i + 1, text: s.text, claims: s.claims, sentence_verdict: s.sentence_verdict };
        }),
        totals: totals,
        fidelity_score: score,
        band: band,
        heard_as: heard,
        ledger_handoff:
          "CWI-HANDOFF gear=playback fidelity=" + score + " band=" + band + " from=" + by + " to=cwi-data"
      };
    }

    return {
      CONFIG: CONFIG,
      splitSentences: splitSentences,
      checkSentence: checkSentence,
      fidelity: fidelity,
      buildReport: buildReport
    };
  }

  return { makeEngine: makeEngine, sha256: sha256 };
});
