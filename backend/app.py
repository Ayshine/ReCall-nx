"""ReCall-nx API — serves the precomputed review data and live KB queries.

Two very different costs live behind these routes:

  /concepts  reads precomputed JSON from disk (precompute.py). Synthesis is far
             too expensive to run per request, so it never happens here.
  /search    live hybrid retrieval against the KB — cheap (one embedding call).
  /ask       live RAG — one embedding call plus one chat completion.

NOTE: embedded Qdrant takes an EXCLUSIVE lock on .kb/. While this app is
running, no other process (including `videodistill kb search`) can open it.

Run:  uvicorn app:app --reload --port 8000
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse

from videodistill.kb import build_store, hybrid_search
from videodistill.llm.base import LLMMessage
from videodistill.llm.cache import CachedLLMClient
from videodistill.llm.openai_provider import OpenAIProvider
from videodistill.models import CanonicalNote, ConceptSource
from videodistill.review.qa import NOT_COVERED, answer_question
from videodistill.review.quiz import generate_question

HERE = Path(__file__).resolve().parent

# The shared data root. The vector DB is the INTERFACE between the distillers
# and this app, so it does not belong inside either pipeline's working tree —
# reaching into the distiller repo's .kb meant ReCall broke if that repo was moved or
# archived, long after its distilling was finished.
#
# Layout:  kb/  synthesis/<collection>/  media/<collection>/  profiles/  languages/
RECALL_DATA = Path(
    os.environ.get("RECALL_DATA", Path.home() / "Documents" / "dbs" / "recall-data")
).resolve()
KB_DIR = Path(os.environ.get("RECALL_KB_DIR", RECALL_DATA / "kb")).resolve()
DATA_DIR = HERE / "data"

# MUST match what ingest used, or the query vectors land in a different space.
EMBED_MODEL = "text-embedding-3-small"
CHAT_MODEL = "gpt-4o-mini"

# ReCall keeps its own env and its own LLM cache rather than borrowing the
# pipeline's — the key is read from the environment first, so nothing has to be
# duplicated in CI or a container.
load_dotenv(HERE / ".env")
_api_key = os.environ.get("OPENAI_API_KEY")
if not _api_key:
    raise SystemExit(
        f"OPENAI_API_KEY not set — put it in {HERE / '.env'} or export it"
    )

llm = CachedLLMClient(OpenAIProvider(api_key=_api_key), RECALL_DATA / "cache")
store = build_store("qdrant", KB_DIR)  # holds the .kb lock for this process

app = FastAPI(title="ReCall-nx API")


def hms(seconds: float) -> str:
    total = int(seconds) if seconds > 0 else 0
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def parse_collections(raw: str) -> list[str]:
    """The UI sends a comma-joined list ("c,cpp"); "both" is a legacy form."""
    if raw == "both":
        return available()
    return [c.strip() for c in raw.split(",") if c.strip()]


@lru_cache(maxsize=None)
def concepts_for(collection: str) -> list[dict]:
    path = DATA_DIR / f"recall_{collection}.json"
    if not path.exists():
        raise HTTPException(
            404,
            f"No precomputed data for '{collection}'. "
            f"Run: python precompute.py --collection {collection}",
        )
    return json.loads(path.read_text(encoding="utf-8"))


def available() -> list[str]:
    return sorted(p.stem.removeprefix("recall_") for p in DATA_DIR.glob("recall_*.json"))


def index_entry(collection: str) -> dict:
    path = DATA_DIR / "index.json"
    index = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return index.get(collection) or {}


@app.get("/slides/{collection}/{filename}")
def slide(collection: str, filename: str) -> FileResponse:
    """Serve a slide screenshot for a collection.

    The images stay on disk where the distiller wrote them — they are far too
    big to live in the vector DB (864 pages of this deck is 246MB, and Qdrant
    payloads are JSON, so they would have to be base64'd and dragged through
    every query). precompute.py records the directory in index.json.
    """
    # Default layout is media/<collection>/; index.json may override for a
    # collection whose images live elsewhere.
    images_dir = index_entry(collection).get("images_dir") or str(
        RECALL_DATA / "media" / collection
    )
    # Resolve and confirm containment: the filename comes from the URL, so a
    # traversal like ../../.env must not escape the images directory.
    root = Path(images_dir).resolve()
    target = (root / filename).resolve()
    if not target.is_file() or root not in target.parents:
        raise HTTPException(404, f"No such slide: {filename}")
    return FileResponse(target)


@app.get("/collections")
def collections() -> dict:
    """Which collections have precomputed data, and how many concepts each has.

    Counts come from data/index.json (written by precompute.py) so this stays a
    cheap call — the concept files are ~13MB each.
    """
    index_path = DATA_DIR / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    names = available()
    return {
        "collections": names,
        "counts": {n: index.get(n, {}).get("concepts", 0) for n in names},
        "hasImages": {n: bool(index.get(n, {}).get("images_dir")) for n in names},
    }


@app.get("/concepts")
def concepts(collection: str = Query("c")) -> dict:
    """Precomputed concepts — what ReviewMode/QuizMode read.

    A collection with no precomputed file is skipped rather than failing the
    whole request: the board can hold sources that have not been through
    precompute.py yet, and one of those must not blank the others.
    """
    have = set(available())
    asked = parse_collections(collection)
    served = [n for n in asked if n in have]
    out: list[dict] = []
    for name in served:
        out.extend(concepts_for(name))
    if not served:
        raise HTTPException(
            404,
            f"No precomputed data for {asked}. Run: python precompute.py "
            f"--collection {asked[0] if asked else '<name>'}",
        )
    return {"results": out, "served": served, "missing": [n for n in asked if n not in have]}


@app.get("/search")
def search(q: str, collection: str = Query("c"), k: int = 8) -> dict:
    results = []
    for name in parse_collections(collection):
        for r in hybrid_search(q, store, name, llm, EMBED_MODEL, k=k):
            item = dict(r.__dict__)
            # The KB stores a float; every UI surface renders hh:mm:ss.
            item["source_timestamp"] = hms(r.source_timestamp)
            results.append(item)
    results.sort(key=lambda r: r["score"], reverse=True)
    return {"results": results[:k]}


@app.get("/ask")
def ask(q: str, collection: str = Query("c"), k: int = 8) -> dict:
    """Always returns a single `answer` string.

    The UI's renderAnswer() parses inline [collection/video @ hh:mm:ss] markers
    out of the text, so multiple collections are joined rather than returned as
    a dict — a dict would reach renderAnswer as a non-string and render nothing.
    """
    names = parse_collections(collection)
    parts: list[str] = []
    for name in names:
        answer = answer_question(q, store, name, llm, EMBED_MODEL, CHAT_MODEL, k=k)
        if answer.strip() == NOT_COVERED:
            continue
        parts.append(f"**{name}** — {answer}" if len(names) > 1 else answer)

    if not parts:
        return {"answer": NOT_COVERED, "covered": False, "citations": []}
    return {"answer": "\n\n".join(parts), "covered": True, "citations": []}


# ---------------------------------------------------------------- quiz -------
#
# Questions and grades are generated ON DEMAND, not precomputed. Pre-generating
# a question for all 13,073 concepts would be ~11 hours of serial LLM calls for
# a quiz that shows one at a time; generating per question costs a fraction of a
# cent and CachedLLMClient makes a repeat of the same concept free.


@lru_cache(maxsize=None)
def concept_index(collection: str) -> dict[str, dict]:
    return {c["canonical_concept_id"]: c for c in concepts_for(collection)}


def find_concept(collection: str, concept_id: str) -> dict:
    hit = concept_index(collection).get(concept_id)
    if hit is None:
        raise HTTPException(404, f"No concept {concept_id!r} in collection {collection!r}")
    return hit


def strip_fence(raw: str) -> str:
    """Unwrap a ```json ... ``` block if the model returned one."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        text = text.rsplit("```", 1)[0]
    return text.strip()


def _json_call(prompt: str) -> dict | None:
    """One chat call expected to return JSON; None if it did not."""
    try:
        raw = llm.complete([LLMMessage(role="user", content=prompt)], model=CHAT_MODEL)
        parsed = json.loads(strip_fence(raw))
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def _mcq(c: dict) -> dict | None:
    """Multiple choice. Distractors must be plausible and wrong, which is the
    part a model gets lazy about — hence the explicit instruction."""
    parsed = _json_call(
        "Write ONE multiple-choice question testing understanding of the "
        "concept below, using only the notes.\n"
        "Give exactly 4 options. The three wrong ones must be plausible and "
        "related — not obviously silly, not restatements of the right answer. "
        "Do not label them A/B/C/D; give the text only.\n"
        'Return ONLY JSON: {"question": "...", "options": ["...","...","...","..."], '
        '"answerIndex": 0-3, "why": "one sentence on why the answer is right"}\n\n'
        f"CONCEPT: {c['concept']}\n\nNOTES: {c['summary']}"
    )
    if not parsed:
        return None
    options = [str(o) for o in parsed.get("options", []) if str(o).strip()]
    idx = parsed.get("answerIndex")
    if len(options) != 4 or not isinstance(idx, int) or not 0 <= idx < 4:
        return None
    return {
        "kind": "mcq",
        "question": str(parsed.get("question", "")).strip(),
        "options": options,
        "answerIndex": idx,
        "why": str(parsed.get("why") or "").strip() or None,
    }


def _code_question(c: dict) -> dict | None:
    """A question about this concept's actual code snippet from the lectures."""
    code = c.get("code")
    if not code or not code.strip():
        return None
    parsed = _json_call(
        "Write ONE short question about the code below, testing whether the "
        "student understands what it does and why. Ask about behaviour, "
        "output, or a pitfall — not trivia like counting lines. Use only what "
        "the notes and code support.\n"
        'Return ONLY JSON: {"question": "..."}\n\n'
        f"CONCEPT: {c['concept']}\n\nNOTES: {c['summary']}\n\nCODE:\n{code}"
    )
    if not parsed or not str(parsed.get("question", "")).strip():
        return None
    return {
        "kind": "code",
        "question": str(parsed["question"]).strip(),
        "code": code,
        "code_language": c.get("code_language"),
    }


@app.get("/quiz/question")
def quiz_question(collection: str, id: str, kind: str = "recall") -> dict:
    """One question for a concept, written from the merged notes.

    kind: recall (open answer) | mcq (multiple choice) | code (about the
    lecture's own snippet). mcq and code fall back to recall if the model
    returns something unusable, or — for code — if the concept has no snippet,
    so the quiz never dead-ends on a concept.
    """
    c = find_concept(collection, id)
    if kind == "mcq":
        built = _mcq(c)
        if built:
            return built
    elif kind == "code":
        built = _code_question(c)
        if built:
            return built
    # generate_question takes a CanonicalNote; rebuild the fields it reads.
    note = CanonicalNote(
        concept=c["concept"],
        canonical_concept_id=c["canonical_concept_id"],
        summary=c["summary"],
        code_snippet=c.get("code"),
        code_language=c.get("code_language"),
        pitfalls=c.get("pitfalls") or [],
        depends_on=c.get("depends_on") or [],
        sources=[ConceptSource(source_video=c["source_video"], source_timestamp=0.0)],
    )
    return {"kind": "recall", "question": generate_question(note, llm, CHAT_MODEL)}


@app.get("/quiz/grade")
def quiz_grade(collection: str, id: str, answer: str, use_llm: bool = True) -> dict:
    """Grade a typed answer against the notes with an LLM judge.

    Replaces the keyword matching the mock layer used, which could only credit
    an answer that reused the notes' own vocabulary. The judge decides the key
    points itself from the merged summary, so grading does not depend on a
    precomputed keyPoints list or a stopword heuristic.
    """
    c = find_concept(collection, id)
    cross_check = (
        '\nAlso set "note" to one sentence on whether the answer contains '
        "anything correct that is NOT in the notes, or says something wrong. "
        'Use null if there is nothing worth saying.'
        if use_llm
        else '\nSet "note" to null.'
    )
    prompt = (
        "You are grading a student's from-memory answer about one concept.\n"
        "Choose EXACTLY the 3 or 4 points most central to understanding the "
        "concept. Judge understanding, not recall of the lecture: ignore "
        "incidental examples, specific function names used only as "
        "illustration, and asides — a student who understands the concept but "
        "never saw this lecture should be able to score well.\n"
        "Then decide for each point whether the ANSWER conveys it. Accept "
        "correct paraphrases, synonyms and different wording; credit meaning, "
        "not matching words.\n"
        'Return ONLY JSON: {"points": [{"point": "...", "hit": true|false}], '
        '"note": "..."|null}'
        f"{cross_check}\n\n"
        f"CONCEPT: {c['concept']}\n\nNOTES: {c['summary']}"
        + (f"\n\nCODE:\n{c['code']}" if c.get("code") else "")
        + f"\n\nANSWER: {answer}"
    )
    try:
        raw = llm.complete([LLMMessage(role="user", content=prompt)], model=CHAT_MODEL)
        parsed = json.loads(strip_fence(raw))
        points = [
            {"point": str(p["point"]), "hit": bool(p["hit"])}
            for p in parsed.get("points", [])
            if p.get("point")
        ]
        llm_note = parsed.get("note")
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        # Never fail the quiz on a malformed judge reply — fall back to the
        # precomputed keyPoints so the user still gets a grade.
        points = [
            {"point": kp["point"], "hit": any(
                k.lower() in answer.lower() for k in kp.get("kw", []))}
            for kp in (c.get("keyPoints") or [])
        ]
        llm_note = "Judge reply was unreadable; fell back to keyword matching."

    if not points:
        points = [{"point": c["summary"], "hit": False}]
    hits = sum(1 for p in points if p["hit"])
    score = round(hits / len(points) * 100)
    return {
        "score": score,
        "verdict": "Solid" if score >= 80 else "Partial" if score >= 40 else "Missed",
        "points": points,
        "llmNote": llm_note,
        "modelAnswer": c["summary"],
        "citation": {
            "collection": c["collection"],
            "source_video": c["source_video"],
            "source_timestamp": c["source_timestamp"],
        },
    }
