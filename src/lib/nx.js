// ReCall-nx — the "n×" speed model.
//
// You watched the full lecture course once. Reviewing it again at 1× would take
// just as long. ReCall-nx compresses that: at n×, your review budget is
// (original hours / n). A higher n means less time, which means the app shows
// fewer, denser concepts and paces you faster. A lower n means more time, more
// concepts, and full detail.
//
// Default is 10× (the user's preference): a 160-hour course reviewed in ~16h.

// Full original lecture length per collection (hours):
// C was ~160 hrs of lecture, C++ ~160 hours.
// The 1x baseline: how long the source material takes to go through once.
// For the video courses that is the lecture runtime. A slide deck has no
// runtime, so its baseline is the measured cost of reading every concept with
// every screenshot — 2.6h of prose plus 2.9h of slides for the AWS deck.
// Without an entry here the default of 160 would promise a 16h review of a
// deck that only holds 5.5h of material.
export const ORIGINAL_HOURS = {
  c: 160,
  cpp: 160,
  "AWS-Certified-ML-Engineer-Associate": 5.5,
};

export const COLLECTION_LABEL = {
  c: "C",
  cpp: "C++",
  "AWS-Certified-ML-Engineer-Associate": "AWS ML",
};

// Density tiers, chosen by how much time n leaves per concept. Each tier decides
// how much of a concept we surface and roughly how long a reader spends on it.
export const TIERS = [
  {
    id: "deep",
    label: "Deep",
    blurb: "Every concept, full notes + code.",
    detail: "full",
    secondsPerConcept: 75,
  },
  {
    id: "standard",
    label: "Standard",
    blurb: "Important concepts, summaries + code.",
    detail: "summary",
    secondsPerConcept: 35,
  },
  {
    id: "skim",
    label: "Skim",
    blurb: "Key concepts, one-line each.",
    detail: "oneline",
    secondsPerConcept: 15,
  },
  {
    id: "flash",
    label: "Flash",
    blurb: "Headlines only — jog the memory.",
    detail: "headline",
    secondsPerConcept: 6,
  },
];

export function tierForN(n) {
  if (n <= 4) return TIERS[0];
  if (n <= 12) return TIERS[1];
  if (n <= 40) return TIERS[2];
  return TIERS[3];
}

// Concepts carry an importance 1–5 (5 = foundational). A given n keeps concepts
// at or above an importance floor, so speeding up drops the long tail first.
export function importanceFloorForN(n) {
  // Retuned once the budget actually bound. Coverage and depth trade directly:
  // at 10x on C, floor 2 keeps 5,499 concepts but a real sentence each eats
  // 15.8h of the 16h, leaving room for only 437 code snippets. Floor 3 keeps
  // 2,041 and shows 1,549 — 3.5x the code, on the concepts that recur or carry
  // pitfalls. Floor 4 is too aggressive: 804 concepts cannot even spend 16h.
  if (n <= 4) return 1;
  if (n <= 8) return 2;
  if (n <= 25) return 3;
  return 4;
}

export const clampN = (n) => Math.min(80, Math.max(1, Math.round(n)));

// Budget (hours) to review a whole collection at n×.
export function reviewBudgetHours(collection, n) {
  const base = ORIGINAL_HOURS[collection] ?? 160;
  return base / n;
}

// Accepts an array of collection ids (e.g. ["c", "cpp"]) — the source board is
// multi-select. Legacy string forms ("both", "cpp") are still tolerated.
export function collectionsFor(selection) {
  if (Array.isArray(selection)) return selection;
  return selection === "both" ? ["c", "cpp"] : [selection];
}

// Combined original hours across the chosen collection(s).
export function originalHoursFor(selection) {
  return collectionsFor(selection).reduce(
    (sum, c) => sum + (ORIGINAL_HOURS[c] ?? 160),
    0
  );
}

export function budgetHoursFor(selection, n) {
  return originalHoursFor(selection) / n;
}

// Where a concept sits in the original course. Falls back to the dependency
// order for data precomputed before course_order existed.
const courseSeq = (c) => c.course_order ?? c.order ?? 0;

// course_order is ranked WITHIN a collection, so it is only comparable between
// concepts of the same course: C's #500 and C++'s #500 are unrelated. Sorting
// the merged pool on it alone interleaves the two courses almost every card.
// Each course is cumulative in itself, so walk one to the end, then the next —
// in the order the sources were selected (their order in the fetched pool).
function collectionRank(concepts) {
  const rank = new Map();
  for (const c of concepts) {
    if (!rank.has(c.collection)) rank.set(c.collection, rank.size);
  }
  return rank;
}

const bySource = (rank) => (a, b) =>
  (rank.get(a.collection) ?? 0) - (rank.get(b.collection) ?? 0) ||
  courseSeq(a) - courseSeq(b);

// Pick + shape the concepts to show for a given n, as a TWO-PHASE run.
//
// Phase 1 "Walkthrough" — everything above the importance floor, in course
// order. The courses are cumulative (lecture 30 assumes lecture 3), so the
// first pass follows the sequence the material was actually taught in rather
// than jumping to whatever is most important.
//
// Phase 2 "Priority pass" — a shorter drill over the concepts that outrank the
// floor, most foundational first. This is where importance drives the order.
//
// Importance decides WHAT is shown (the floor rises with n); time decides the
// sequence of phase 1. The time budget is a reference shown to the user, not a
// cap — nothing here truncates to fit it.
//
// Returns { shown, phases, tier, floor, droppedCount }. `shown` is the flat
// run in phase order, which is what ReviewMode steps through.
// Spend a time budget on detail. Everything that survives the floor appears —
// at minimum as a headline — and the budget is then spent upgrading the most
// important concepts, first to a line, then to the full note with code.
//
// This is what makes n mean what it claims. At 10x a 160h course must fit 16h,
// but for C the full notes are 77.8h and one line each is 9.4h, so no single
// depth lands on the target: the review has to be MIXED. Roughly 680 of the
// most important concepts get full notes and the remaining ~4,800 get a line.
//
// Returns a Map of concept id -> "headline" | "oneline" | "summary".
export function allocateDetail(kept, budgetSeconds) {
  const detail = new Map();
  let spent = 0;
  for (const c of kept) {
    detail.set(c.canonical_concept_id, "headline");
    spent += conceptSeconds(c, "headline");
  }

  // Most-foundational first. Within a band, a concept carrying its own code
  // wins: the snippet is the part worth re-reading, and it only renders at the
  // summary level, so a code concept left at "oneline" loses its code entirely.
  const hasOwnCode = (c) => (hasVisual(c) ? 1 : 0);
  const order = [...kept].sort(
    (a, b) =>
      b.importance - a.importance ||
      hasOwnCode(b) - hasOwnCode(a) ||
      (a.course_order ?? a.order ?? 0) - (b.course_order ?? b.order ?? 0)
  );

  // Pass 1: lift everyone affordable to a line — coverage beats depth.
  for (const c of order) {
    const delta = conceptSeconds(c, "oneline") - conceptSeconds(c, "headline");
    if (spent + delta > budgetSeconds) break;
    detail.set(c.canonical_concept_id, "oneline");
    spent += delta;
  }

  // Pass 2: buy back the code. Cheaper per concept than a full summary and,
  // by your rule, the more valuable half — so it is bought first.
  for (const c of order) {
    if (detail.get(c.canonical_concept_id) !== "oneline") continue;
    if (!hasVisual(c)) continue;
    const delta = conceptSeconds(c, "code") - conceptSeconds(c, "oneline");
    if (spent + delta > budgetSeconds) continue;
    detail.set(c.canonical_concept_id, "code");
    spent += delta;
  }

  // Pass 3: spend whatever is left deepening the most important to full notes.
  for (const c of order) {
    const at = detail.get(c.canonical_concept_id);
    if (at !== "oneline" && at !== "code") continue;
    const delta = conceptSeconds(c, "summary") - conceptSeconds(c, at);
    if (delta <= 0 || spent + delta > budgetSeconds) continue;
    detail.set(c.canonical_concept_id, "summary");
    spent += delta;
  }
  return { detail, spent };
}

export function planReview(concepts, n, cardSeconds = DEFAULT_CARD_SECONDS) {
  const tier = tierForN(n);
  const floor = importanceFloorForN(n);
  const kept = concepts.filter((c) => c.importance >= floor);

  // Budget from the courses actually in the pool, so multi-select adds hours.
  const sources = [...new Set(concepts.map((c) => c.collection))];
  const budgetSeconds =
    (sources.reduce((sum, id) => sum + (ORIGINAL_HOURS[id] ?? 160), 0) / n) * 3600;
  const { detail: detailFor, spent } = allocateDetail(kept, budgetSeconds);

  const levelOf = (c) => detailFor.get(c.canonical_concept_id) ?? "headline";

  const rank = collectionRank(concepts);
  const walkthrough = [...kept].sort(bySource(rank));

  // The priority pass is importance-first by design, so it may cross sources —
  // that is the point of a drill. Ties fall back to source then course order.
  const priority = kept
    .filter((c) => c.importance > floor)
    .sort((a, b) => b.importance - a.importance || bySource(rank)(a, b));

  const phases = [
    {
      id: "walkthrough",
      label: "Walkthrough",
      blurb: "Course order — the material is cumulative.",
      items: walkthrough,
    },
    {
      id: "priority",
      label: "Priority pass",
      blurb: "The concepts most else depends on, first.",
      items: priority,
    },
  ]
    .filter((p) => p.items.length > 0)
    .map((p) => ({
      ...p,
      cards: packCards(p.items, levelOf, cardSeconds),
    }));

  const cards = phases.flatMap((p) => p.cards);
  const levels = { headline: 0, oneline: 0, code: 0, summary: 0 };
  for (const c of kept) levels[levelOf(c)] += 1;

  return {
    shown: phases.flatMap((p) => p.items),
    cards,
    cardSeconds,
    levelOf,
    levels,
    budgetSeconds,
    // What the walkthrough actually costs. The priority pass revisits concepts
    // already counted, so it is deliberately excluded from the budget.
    spentSeconds: spent,
    // Real total reading time of the run, not cards x target — the last card of
    // each lecture is usually short, and a single long concept can overshoot.
    totalSeconds: cards.reduce((sum, c) => sum + c.seconds, 0),
    phases,
    tier,
    floor,
    // kept = distinct concepts surviving the floor. runLength counts CARDS,
    // which is larger because the priority pass revisits a subset. Reporting
    // runLength as "kept" would print more concepts than the collection holds.
    keptCount: kept.length,
    runLength: phases.reduce((sum, p) => sum + p.items.length, 0),
    droppedCount: concepts.length - kept.length,
  };
}

// Which phase a given index of `shown` falls in — for a divider in the runner.
export function phaseAt(plan, index) {
  let start = 0;
  for (const phase of plan.phases) {
    if (index < start + phase.items.length) {
      return { phase, indexInPhase: index - start, startsPhase: index === start };
    }
    start += phase.items.length;
  }
  return null;
}

// Human-friendly duration from hours (e.g. 16 -> "16h", 0.4 -> "24m").
export function fmtHours(h) {
  if (h >= 1) {
    let whole = Math.floor(h);
    let mins = Math.round((h - whole) * 60);
    // 15.99h rounded naively prints "15h 60m"; carry the overflow.
    if (mins === 60) {
      whole += 1;
      mins = 0;
    }
    return mins ? `${whole}h ${mins}m` : `${whole}h`;
  }
  return `${Math.max(1, Math.round(h * 60))}m`;
}

// How much MATERIAL goes on one card, expressed as reading time. One concept
// per card meant ~7,500 two-sentence cards for a single course — technically a
// review, practically an eternity of clicking. A card now holds as many
// consecutive concepts as fit the chosen duration, so "2 min" means two
// minutes of reading, not two minutes parked on two sentences.
export const PACE_OPTIONS = [
  { id: "30", label: "30s", seconds: 30 },
  { id: "60", label: "1 min", seconds: 60 },
  { id: "120", label: "2 min", seconds: 120 },
  { id: "300", label: "5 min", seconds: 300 },
];

export const DEFAULT_CARD_SECONDS = 120;

// Silent-reading pace for technical prose. Code is slower to read than prose,
// so it is weighted more heavily rather than counted word-for-word.
const WORDS_PER_MINUTE = 200;
const CODE_SECONDS_PER_LINE = 2.5;
// A slide is taken in as a whole rather than read line by line. Twelve seconds
// is a considered look — long enough to read a bullet list and a diagram.
const SECONDS_PER_IMAGE = 12;

function wordCount(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

// What a concept actually renders at this depth — the card is sized on what is
// on screen, not on data the tier hides.
// The verbatim material attached to a concept: a code snippet, slide
// screenshots, or both. Never paraphrased, so it is costed as-is.
export function visualSeconds(c) {
  let secs = 0;
  if (c.code && !c.code_repeat_of) {
    secs += (c.code.split("\n").length || 1) * CODE_SECONDS_PER_LINE;
  }
  secs += (c.images?.length ?? 0) * SECONDS_PER_IMAGE;
  return secs;
}

export function hasVisual(c) {
  return Boolean((c.code && !c.code_repeat_of) || c.images?.length);
}

export function conceptSeconds(c, detail) {
  if (detail === "headline") return Math.max(2, wordCount(c.headline) / WORDS_PER_MINUTE * 60);
  if (detail === "oneline") return Math.max(3, wordCount(c.oneline) / WORDS_PER_MINUTE * 60);
  // "code" = the one-line summary PLUS its verbatim visual (snippet and/or
  // slide screenshots). These only used to render at full-summary depth, which
  // hid them: 4,877 of C's concepts carry a snippet but sat at one-line, so the
  // code — the part worth re-reading — was invisible. Same for slide decks,
  // where the screenshot IS the material. This buys the visual without paying
  // for the full narrative.
  if (detail === "code") {
    return Math.max(3, wordCount(c.oneline) / WORDS_PER_MINUTE * 60) + visualSeconds(c);
  }
  let secs = (wordCount(c.summary) / WORDS_PER_MINUTE) * 60;
  // Repeated snippets are collapsed to a back-reference, so they cost nothing
  // to re-read. Code itself is never paraphrased — only shown once.
  secs += visualSeconds(c);
  return Math.max(5, secs);
}

// Pack consecutive concepts into cards of roughly `target` seconds. Never spans
// a lecture or a source: a card should read as one sitting of one course, and
// course order already keeps related concepts adjacent.
export function packCards(items, detailFor, target) {
  const cards = [];
  let cur = [];
  let secs = 0;
  for (const c of items) {
    const t = conceptSeconds(c, detailFor(c));
    const breaks =
      cur.length > 0 &&
      (cur[0].collection !== c.collection ||
        cur[0].lecture !== c.lecture ||
        secs + t > target);
    if (breaks) {
      cards.push({ items: cur, seconds: secs });
      cur = [];
      secs = 0;
    }
    cur.push(c);
    secs += t;
  }
  if (cur.length > 0) cards.push({ items: cur, seconds: secs });
  return cards;
}

// "35s", "2 min", "1m 30s" — a bare `${n}s` reads badly past a minute.
export function fmtDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m}m ${r}s`;
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
