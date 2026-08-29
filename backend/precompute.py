"""Map a distiller synthesis into ReCall-nx review data.

Division of labour:

  The distillers own the KB and the synthesis. `videodistill synthesize
                 --collection c --out <dir>` dedups notes into canonical
                 concepts, orders them by dependency, and writes synthesis.json.
                 That is its artifact; this script never recomputes it. Both
                 land under $RECALL_DATA, not inside a pipeline repo.

  ReCall-nx      owns n× — deciding what a 2× or 40× review actually shows.
                 That is the mapping below: importance banding, the depth
                 fields (headline/oneline) each tier renders, and the quiz
                 fields. Nothing here calls an LLM or opens the vector DB.

Fields and where they come from:

  order       position in synthesis.notes (already topologically sorted)
  importance  dependency in-degree, percentile-banded to 1-5
  headline    the concept name                            (derived)
  oneline     first sentence of the summary               (derived)
  question    template over the concept name              (derived)
  keyPoints   summary sentences + content-word keywords   (derived)

The four derived fields are deliberately cheap so the pipeline can be proven
end to end with no LLM spend. Upgrading them later (generate_question, an
LLM headline/oneline pass) does not change this file's output shape.

Usage:
    python precompute.py --collection c
        (reads $RECALL_DATA/synthesis/c/synthesis.json by default)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import yaml

# Importance is RULE-based, not percentile-based, because this corpus does not
# contain five distinguishable tiers. Of 6,542 C concepts, 5,148 (79%) are a
# single mention in a single lecture — indistinguishable from each other. Fixed
# percentile bands would split that undifferentiated mass at arbitrary
# cutoffs, which in practice means alphabetically by concept id.
#
# The rules below rank on signals that actually vary, so that each floor in
# nx.js (importanceFloorForN: 1/2/3/4) removes a meaningfully different set:
#
#   5  taught across 3+ lectures      the instructor keeps coming back to it
#   4  taught across 2 lectures       recurs, but not a spine
#   3  one lecture, but emphasised    repeated in-lecture, or carries pitfalls
#   2  one lecture, one mention, code a concrete worked example
#   1  one lecture, one mention, no code   the thin tail

# Lecture number out of a source filename. Two conventions are in play: the
# temp-ingested "lecture_35.mp4" and the external-drive "5. ders 28 Agustos
# 2019.mp4" — the FIRST integer is the lecture in both (28/2019 are the date).
LECTURE_NUM = re.compile(r"\d+")

# Markdown image links inside a note's `diagram`. Slide decks put a screenshot
# here ("![slide p271](images/page_0271.png)"); video courses put ASCII art, so
# a diagram with no link is passed through as text rather than an image.
IMAGE_LINK = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
# Keeps :, +, # and _ so code tokens (std::vector, malloc, size_t) survive as
# single keywords — they are the highest-signal matches when grading an answer.
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_:+#-]*")


def load_vocabulary(repo: Path, collection: str) -> list[re.Pattern]:
    """Domain terms from the course profile, as word-boundary patterns.

    Reusing profiles/<collection>.yaml rather than inventing a keyword list
    keeps the domain knowledge in the one place the pipeline already declares
    it. Boundaries matter: a bare "int" would otherwise match inside "point".
    """
    path = repo / "profiles" / f"{collection}.yaml"
    if not path.exists():
        return []
    profile = yaml.safe_load(path.read_text("utf-8")) or {}
    return [
        re.compile(r"(?<![A-Za-z0-9_])" + re.escape(str(v).lower()) + r"(?![A-Za-z0-9_])")
        for v in (profile.get("vocabulary") or [])
    ]


def vocab_hits(note: dict, patterns: list[re.Pattern]) -> int:
    blob = f"{note.get('concept','')} {note.get('summary','')}".lower()
    return sum(1 for p in patterns if p.search(blob))


# Course administration: schedules, attendance policy, which chat group to join.
# Detected POSITIVELY. The tempting inverse — "no domain vocabulary means not
# topical" — wrongly demoted real material like "Advantages of Linked Lists" and
# "Algorithm and Complexity", because the profile vocabulary covers pointers and
# stdlib calls but not data structures or general CS terms.
#
# Two collisions to avoid, both learned the hard way on this corpus:
#   - bare clock/weekday matches hit the date-arithmetic exercises ("Calendar
#     Time in Programming"), so a time only counts next to a course word.
#   - "class" is a C++ keyword and "assignment" is a C operator, so neither can
#     be an administrative marker.
_SCHEDULE = r"(?:\b\d{1,2}:\d{2}\b|\b(?:monday|tuesday|wednesday|thursday|friday)s?\b)"
_COURSE_WORD = r"\b(?:course|lesson|lecture)\b"
ADMIN_MARKER = re.compile(
    "|".join(
        [
            rf"{_SCHEDULE}.{{0,80}}{_COURSE_WORD}",
            rf"{_COURSE_WORD}.{{0,80}}{_SCHEDULE}",
            # NOT "dropout": in an ML deck that is the regularisation
            # technique, and it was demoting a core concept. Course-leaving is
            # already covered by attendance/absenteeism.
            r"\b(attendance|absentee\w*|absenteeism)\b",
            r"\b(homework|syllabus|enroll\w*|semester)\b",
            r"\b(telegram|whatsapp|discord)\b",
            r"\bcourse (lasts|starts|is held|structure|schedule|participation"
            r"|objectives|overview|program)\b",
            r"\b(instructor will (share|provide)|recommended (books|resources)"
            r"|reading list)\b",
        ]
    ),
    re.I,
)


def is_admin(note: dict, hits: int) -> bool:
    """Course logistics rather than course content.

    Requires BOTH an administrative marker AND no technical evidence. A single
    marker alone is not enough: plenty of genuinely technical concepts carry an
    incidental aside ("also assigned as homework", "ask on Telegram"), and
    demoting those on one sentence loses real material.
    """
    if (note.get("code_snippet") or "").strip() or hits:
        return False
    return bool(ADMIN_MARKER.search(f"{note.get('concept','')} {note.get('summary','')}"))


def code_key(code: str | None) -> str | None:
    """Whitespace-insensitive fingerprint, for spotting a snippet reused across
    concepts — the same example re-shown in a later lecture is not new material."""
    if not code or not code.strip():
        return None
    return hashlib.md5(re.sub(r"\s+", "", code).encode("utf-8")).hexdigest()


def load_stopwords(repo: Path) -> set[str]:
    path = repo / "languages" / "en" / "stopwords.txt"
    if not path.exists():
        return set()
    return {w.strip().lower() for w in path.read_text("utf-8").splitlines() if w.strip()}


def hms(seconds: float) -> str:
    """Seconds -> hh:mm:ss. The KB stores a float; every UI surface wants text."""
    total = int(seconds) if seconds > 0 else 0
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def locator(value: float, is_page: bool) -> str:
    """Render a note's position in its source.

    The KB has one numeric locator field, but it means different things: for
    video it is seconds into the lecture, for a slide deck it is the page. A
    page rendered through hms() reads as "00:09:42" for slide 582 — a timestamp
    into a document that has no duration.
    """
    return f"page {int(value)}" if is_page else hms(value)


def lecture_number(source_video: str) -> int:
    """First integer in the filename; unnumbered sources sort to the end."""
    m = LECTURE_NUM.search(source_video or "")
    return int(m.group()) if m else 10**6


def sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE_SPLIT.split(text.strip()) if s.strip()]


def oneline_of(summary: str, cap: int = 160) -> str:
    parts = sentences(summary)
    first = parts[0] if parts else summary.strip()
    return first if len(first) <= cap else first[: cap - 1].rstrip() + "…"


def keywords(sentence: str, stops: set[str], limit: int = 6) -> list[str]:
    out: list[str] = []
    for raw in WORD.findall(sentence):
        w = raw.lower()
        if len(w) < 4 or w in stops or w in out:
            continue
        out.append(w)
        if len(out) >= limit:
            break
    return out


def key_points(summary: str, stops: set[str], limit: int = 4) -> list[dict]:
    points = [
        {"point": s, "kw": kw}
        for s in sentences(summary)[:limit]
        if (kw := keywords(s, stops))
    ]
    if not points:  # a terse summary still has to be gradeable
        points = [{"point": summary.strip(), "kw": keywords(summary, stops)}]
    return points


def distinct_lectures(note: dict) -> int:
    """How many different lectures teach this concept.

    This is the importance signal. The obvious alternative — dependency
    in-degree — is unusable on this corpus: only 94 of 6,542 C concepts declare
    any depends_on at all, and of 184 edges, 81 dangle (the id is not a concept
    that exists). That leaves ~103 usable edges over 6,542 nodes, so ranking by
    in-degree ties 99% of concepts at zero and the percentile bands degenerate
    into alphabetical order by concept id.

    Breadth of coverage is real and dense by comparison: 21% of concepts are
    taught in more than one lecture, spread as wide as 18. An instructor who
    returns to a topic across many lectures is telling you it is foundational.
    Counting DISTINCT lectures, not sources — a concept revisited six times
    within one lecture is emphasis, not breadth.
    """
    return len({lecture_number(s["source_video"]) for s in (note.get("sources") or [])})


def in_degrees(notes: list[dict]) -> dict[str, int]:
    """How many concepts depend ON each concept. Edges to unknown ids ignored."""
    known = {n["canonical_concept_id"] for n in notes}
    degree: dict[str, int] = defaultdict(int)
    for note in notes:
        for dep in note.get("depends_on") or []:
            if dep in known:
                degree[dep] += 1
    return degree


def importance_of(note: dict, degree: dict[str, int], topical: bool = True) -> int:
    """Score one concept 1-5 (5 = foundational). See the rule table above.

    Course administration — schedules, attendance policy, which Telegram group
    to join — is pinned to 1 however often it recurs. It is repeated across
    lectures precisely because it is announcements, which would otherwise score
    it as foundational. `topical` is false when a concept matches no term from
    the course vocabulary and carries no code.
    """
    if not topical:
        return 1
    lectures = distinct_lectures(note)
    if lectures >= 3:
        return 5
    if lectures == 2:
        return 4
    # A real dependency edge is rare here (only ~103 resolve across the whole
    # collection) but is strong evidence when it does exist, so let it promote.
    if degree.get(note["canonical_concept_id"], 0) > 0:
        return 4
    mentions = len(note.get("sources") or [])
    if mentions > 1 or note.get("pitfalls"):
        return 3
    # A slide screenshot is material in exactly the way a code snippet is: it is
    # the thing the concept was taught with. Counting only code sent 724 of the
    # 830 AWS concepts to the bottom band, because a slide deck has no code.
    has_material = note.get("code_snippet") or (note.get("diagram") or "").strip()
    return 2 if has_material else 1


def importance_map(
    notes: list[dict], degree: dict[str, int], topical: dict[str, bool]
) -> dict[str, int]:
    return {
        n["canonical_concept_id"]: importance_of(
            n, degree, topical.get(n["canonical_concept_id"], True)
        )
        for n in notes
    }


def load_written(data_dir: Path, field: str, collection: str) -> dict[str, str]:
    """Text written by summarize.py, if it has been run for this field.

    Absent or partial is fine. A missing `oneline` falls back to the first
    sentence of the summary; a missing `summary` keeps the synthesis original.
    """
    path = data_dir / f"{field}_{collection}.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {k: v["text"] for k, v in raw.items() if isinstance(v, dict) and v.get("text")}


def to_nx(
    synthesis: dict,
    collection: str,
    stops: set[str],
    vocab: list[re.Pattern],
    onelines: dict[str, str] | None = None,
    summaries: dict[str, str] | None = None,
) -> list[dict]:
    notes = synthesis.get("notes") or []
    # A collection whose notes carry image links is a document, not a video, so
    # its locator is a page number.
    is_page = any(IMAGE_LINK.search(n.get("diagram") or "") for n in notes)
    degree = in_degrees(notes)
    hits = {n["canonical_concept_id"]: vocab_hits(n, vocab) for n in notes}
    topical = {
        n["canonical_concept_id"]: not is_admin(n, hits[n["canonical_concept_id"]])
        for n in notes
    }
    scores = importance_map(notes, degree, topical)
    onelines = onelines or {}
    summaries = summaries or {}

    out = []
    dropped_admin = []
    for order, note in enumerate(notes, start=1):
        cid = note["canonical_concept_id"]
        # Course logistics teach nothing about the language. Dropped outright
        # rather than demoted: pinning to importance 1 still surfaced them at
        # 2x-4x, where the floor is 1.
        if not topical[cid]:
            dropped_admin.append(note.get("concept") or cid)
            continue
        # Prefer the de-narrated rewrite; ~40% of synthesis summaries open with
        # "The speaker explains that ...", which is noise on a study card.
        summary = summaries.get(cid) or note.get("summary") or ""
        # Cite where the concept is FIRST taught — the earliest timestamp is the
        # one worth rewatching, not whichever source happens to be listed first.
        sources = note.get("sources") or []
        first = min(sources, key=lambda s: s["source_timestamp"], default=None)
        out.append(
            {
                "canonical_concept_id": cid,
                "collection": collection,
                "source_video": first["source_video"] if first else "",
                "source_timestamp": (
                    locator(first["source_timestamp"], is_page) if first
                    else ("page 1" if is_page else "00:00:00")
                ),
                "concept": note.get("concept") or cid,
                "headline": note.get("concept") or cid,
                # A written précis when summarize.py has produced one; the
                # first-sentence truncation only as a fallback.
                "oneline": onelines.get(cid) or oneline_of(summary),
                "oneline_written": cid in onelines,
                "summary_written": cid in summaries,
                "summary": summary,
                "code_language": note.get("code_language"),
                "code": note.get("code_snippet"),
                # Visuals are never summarised — for a slide deck the screenshot
                # IS the material, so it is carried verbatim like code.
                "diagram": note.get("diagram") or None,
                "images": IMAGE_LINK.findall(note.get("diagram") or ""),
                "pitfalls": note.get("pitfalls") or [],
                "depends_on": note.get("depends_on") or [],
                "importance": scores[cid],
                "in_degree": degree.get(cid, 0),
                "lectures": distinct_lectures(note),
                "vocab_hits": hits[cid],
                "topical": topical[cid],
                "order": order,
                "lecture": lecture_number(first["source_video"] if first else ""),
                "t_seconds": float(first["source_timestamp"]) if first else 0.0,
                "score": 1.0,
                "question": f"From memory: what is {note.get('concept') or cid}, and why does it matter?",
                "keyPoints": key_points(summary, stops),
            }
        )

    # course_order: the sequence the material was originally taught in. The n×
    # review's first phase walks this, because the courses are cumulative —
    # lecture 30 assumes lecture 3. Distinct from `order`, which is the
    # dependency topological sort.
    for rank, c in enumerate(
        sorted(out, key=lambda c: (c["lecture"], c["t_seconds"])), start=1
    ):
        c["course_order"] = rank

    # Code is never paraphrased — but the SAME snippet re-shown in a later
    # lecture is not new material. Keep the first occurrence in course order and
    # mark the rest so the UI can collapse them and point back.
    first_seen: dict[str, str] = {}
    for c in sorted(out, key=lambda c: c["course_order"]):
        key = code_key(c.get("code"))
        if key is None:
            continue
        if key in first_seen:
            c["code_repeat_of"] = first_seen[key]
        else:
            first_seen[key] = c["canonical_concept_id"]
    to_nx.dropped_admin = dropped_admin
    return out


def main() -> int:
    here = Path(__file__).resolve().parent
    root = Path(
        os.environ.get("RECALL_DATA", Path.home() / "Documents" / "dbs" / "recall-data")
    ).resolve()

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--collection", required=True)
    ap.add_argument("--synthesis", type=Path, default=None,
                    help="synthesis.json (default: $RECALL_DATA/synthesis/<collection>/synthesis.json)")
    ap.add_argument("--repo", type=Path, default=root,
                    help="data root holding profiles/ and languages/ (default: $RECALL_DATA)")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument(
        "--images",
        type=Path,
        default=None,
        help="directory the note image links resolve against; recorded in "
        "index.json so the API can serve them",
    )
    args = ap.parse_args()

    src = args.synthesis or root / "synthesis" / args.collection / "synthesis.json"
    if not src.exists():
        print(
            f"No synthesis at {src}\n"
            f"Build it first, from the distiller repo:\n"
            f"  videodistill synthesize --collection {args.collection} "
            f"--out synthesis/{args.collection}",
            file=sys.stderr,
        )
        return 1

    synthesis = json.loads(src.read_text(encoding="utf-8"))
    repo = args.repo.resolve()
    data_dir = (args.out or here / "data" / "x").parent
    concepts = to_nx(
        synthesis,
        args.collection,
        load_stopwords(repo),
        load_vocabulary(repo, args.collection),
        load_written(data_dir, "oneline", args.collection),
        load_written(data_dir, "summary", args.collection),
    )

    out = args.out or here / "data" / f"recall_{args.collection}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(concepts, ensure_ascii=False, indent=1), encoding="utf-8")

    # A tiny sidecar index: the source board needs per-collection counts, and
    # parsing every recall_*.json (13MB each) just to length them would be absurd.
    index_path = out.parent / "index.json"
    index = {}
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding="utf-8"))
    entry = {"concepts": len(concepts)}
    if args.images:
        entry["images_dir"] = str(args.images.resolve())
    elif (root / "media" / args.collection).is_dir():
        entry["images_dir"] = str(root / "media" / args.collection)
    elif args.collection in index and "images_dir" in index[args.collection]:
        entry["images_dir"] = index[args.collection]["images_dir"]
    index[args.collection] = entry
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")

    spread: dict[int, int] = {}
    for c in concepts:
        spread[c["importance"]] = spread.get(c["importance"], 0) + 1
    admin = len(getattr(to_nx, "dropped_admin", []))
    repeats = sum(1 for c in concepts if c.get("code_repeat_of"))
    print(f"[{args.collection}] {synthesis.get('raw_note_count', '?')} raw notes "
          f"-> {len(concepts)} concepts -> {out}")
    print("  importance spread:", dict(sorted(spread.items(), reverse=True)))
    print(f"  course-admin concepts dropped       : {admin}")
    for name in getattr(to_nx, "dropped_admin", [])[:12]:
        print(f"      - {name[:66]}")
    print(f"  repeated code snippets (collapsed)  : {repeats}")
    written = sum(1 for c in concepts if c.get("oneline_written"))
    rewritten = sum(1 for c in concepts if c.get("summary_written"))
    print(f"  written one-line summaries          : {written}/{len(concepts)}")
    print(f"  de-narrated full summaries          : {rewritten}/{len(concepts)}")
    with_img = sum(1 for c in concepts if c.get("images"))
    if with_img:
        n_imgs = len({i for c in concepts for i in (c.get("images") or [])})
        print(f"  concepts with a screenshot          : {with_img} "
              f"({n_imgs} distinct images)")
        print("  locators rendered as page numbers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
