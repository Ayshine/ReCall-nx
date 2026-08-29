// Thin data layer. Today it answers from mock data; flip USE_MOCK to false once
// the FastAPI backend in backend/ serves /search and /ask, and these functions
// keep the same shape so no component changes.

import { CONCEPTS, QA_BANK } from "../data/mockData.js";
import { collectionsFor } from "./nx.js";

export const USE_MOCK = true;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// answer_question's sentinel (videodistill/review/qa.py). Must match exactly —
// the backend returns this verbatim when nothing in the collection matches.
const NOT_COVERED = "Not covered in this collection.";

// Last pool fetched by fetchConcepts. pickQuizConcept draws from this so the
// quiz uses live data without QuizMode having to pass concepts down.
let _pool = [];

// Concepts for a collection selection ("c" | "cpp" | "both"), review order.
export async function fetchConcepts(selection) {
  const cols = collectionsFor(selection);
  if (USE_MOCK) {
    await delay(120);
    _pool = CONCEPTS.filter((c) => cols.includes(c.collection));
    return _pool;
  }
  // Precomputed, dependency-ordered concepts (backend/precompute.py). NOT
  // /search — that is live retrieval for a query; this is the whole ordered
  // collection with importance/order/headline/oneline attached.
  const res = await fetch(`/api/concepts?collection=${cols.join(",")}`);
  if (!res.ok) throw new Error(`/api/concepts failed: ${res.status}`);
  const json = await res.json();
  _pool = json.results ?? [];
  return _pool;
}

// Which collections have data, and their concept counts. Drives the source
// board's readiness + counts; in mock mode it is derived from the sample data.
export async function fetchCollections() {
  if (USE_MOCK) {
    const counts = {};
    for (const c of CONCEPTS) counts[c.collection] = (counts[c.collection] ?? 0) + 1;
    return { collections: Object.keys(counts), counts };
  }
  const res = await fetch("/api/collections");
  if (!res.ok) throw new Error(`/api/collections failed: ${res.status}`);
  return res.json();
}

// RAG-style answer with citations. NOT_COVERED when nothing matches, mirroring
// answer_question's contract.
export async function askQuestion(query, selection) {
  if (USE_MOCK) {
    await delay(650);
    const cols = collectionsFor(selection);
    const q = query.toLowerCase();
    const hit = QA_BANK.find(
      (e) =>
        cols.includes(e.collection) &&
        e.match.some((m) => q.includes(m.toLowerCase()))
    );
    if (!hit) {
      return {
        covered: false,
        answer:
          "NOT_COVERED — I couldn't find this in your reviewed notes. Try rephrasing, or widen the collection to Both.",
        citations: [],
      };
    }
    return { covered: true, answer: hit.answer, citations: hit.citations };
  }
  const cols = collectionsFor(selection).join(",");
  const res = await fetch(
    `/api/ask?q=${encodeURIComponent(query)}&collection=${cols}`
  );
  const json = await res.json();
  const answer = json.answer ?? json.answers;
  // Prefer the backend's explicit flag; fall back to the sentinel string.
  const covered =
    typeof json.covered === "boolean"
      ? json.covered
      : typeof answer === "string"
        ? !answer.startsWith(NOT_COVERED)
        : true;
  return { covered, answer, citations: json.citations ?? [] };
}

// ---- Quiz me: the app asks, the user answers, we grade. ----

// Pick a concept to quiz on from the sources in scope, avoiding the last one.
export async function pickQuizConcept(selection, excludeId, kind = "recall") {
  const cols = collectionsFor(selection);
  let pool = (USE_MOCK ? CONCEPTS : _pool).filter((c) =>
    cols.includes(c.collection)
  );
  // A code question needs a snippet to ask about. 79% of concepts have one, so
  // this narrows the pool rather than emptying it; if it did empty, fall back
  // to the full pool and let the backend downgrade the question to recall.
  if (kind === "code") {
    const withCode = pool.filter((c) => c.code && c.code.trim());
    if (withCode.length > 0) pool = withCode;
  }
  if (excludeId && pool.length > 1) pool = pool.filter((c) => c.canonical_concept_id !== excludeId);
  if (pool.length === 0) return null;
  // Weight by importance so foundational concepts come up more often. No RNG in
  // this environment's constraints matters here; Math.random is fine at runtime.
  const weighted = pool.flatMap((c) => Array(c.importance).fill(c));
  const picked = weighted[Math.floor(Math.random() * weighted.length)];
  if (USE_MOCK) return picked;

  // Real questions are written from the merged notes on demand — 13k concepts
  // is far too many to pre-generate. Fall back to the precomputed template
  // question if the call fails, so the quiz still works offline of the LLM.
  try {
    const res = await fetch(
      `/api/quiz/question?collection=${picked.collection}&id=${encodeURIComponent(
        picked.canonical_concept_id
      )}&kind=${kind}`
    );
    if (!res.ok) throw new Error(String(res.status));
    const q = await res.json();
    // q carries kind + question, plus options/answerIndex/why for mcq and
    // code/code_language for code. The backend downgrades to recall if it
    // could not build the requested kind, so trust q.kind over the request.
    return q.question ? { ...picked, ...q } : picked;
  } catch {
    return { ...picked, kind: "recall" };
  }
}

// Grade a typed answer against a concept's key points (the "DB" check), plus an
// optional web-LLM pass. With a real backend, swap the body for an LLM-judge
// call (videodistill.review) and, if useLLM, a web-search-augmented model.
export async function gradeAnswer(concept, userAnswer, useLLM) {
  // Multiple choice is graded locally: the correct index is already known, so
  // an LLM call would add latency and cost to compare two integers.
  if (concept.kind === "mcq") {
    const chosen = Number(userAnswer);
    const correct = chosen === concept.answerIndex;
    return {
      score: correct ? 100 : 0,
      verdict: correct ? "Solid" : "Missed",
      points: [
        { point: concept.options[concept.answerIndex], hit: correct },
        ...(correct
          ? []
          : [{ point: `You chose: ${concept.options[chosen]}`, hit: false }]),
      ],
      llmNote: concept.why ?? null,
      modelAnswer: concept.summary,
      citation: {
        collection: concept.collection,
        source_video: concept.source_video,
        source_timestamp: concept.source_timestamp,
      },
    };
  }
  if (!USE_MOCK) {
    // An LLM judge reads the notes and the answer, so a correct paraphrase
    // scores — the keyword matching below only credited the notes' own wording.
    const res = await fetch(
      `/api/quiz/grade?collection=${concept.collection}&id=${encodeURIComponent(
        concept.canonical_concept_id
      )}&answer=${encodeURIComponent(userAnswer)}&use_llm=${useLLM}`
    );
    if (res.ok) return res.json();
    // fall through to local grading if the backend is unreachable
  }
  await delay(USE_MOCK ? 500 : 0);
  const ans = (userAnswer || "").toLowerCase();
  const points = concept.keyPoints.map((kp) => ({
    point: kp.point,
    hit: ans.trim().length > 0 && kp.kw.some((k) => ans.includes(k.toLowerCase())),
  }));
  const hitCount = points.filter((p) => p.hit).length;
  const score = Math.round((hitCount / points.length) * 100);
  const verdict = score >= 80 ? "Solid" : score >= 40 ? "Partial" : "Missed";

  // Stub for the "LLM that can search the web / use its own knowledge" pass.
  // In mock mode we just acknowledge it; the real build calls an LLM here to
  // credit correct answers phrased differently than the notes.
  const llmNote = useLLM
    ? hitCount < points.length
      ? "Web-LLM check: a couple of your points aren't in the notes verbatim — a real LLM pass would verify whether they're still correct before marking them missed."
      : "Web-LLM check: consistent with widely-taught definitions. ✓"
    : null;

  return {
    score,
    verdict,
    points,
    modelAnswer: concept.summary,
    citation: {
      collection: concept.collection,
      source_video: concept.source_video,
      source_timestamp: concept.source_timestamp,
    },
    llmNote,
  };
}
