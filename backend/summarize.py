"""Write a real one-sentence summary for every concept.

The `oneline` field started life as the summary's FIRST SENTENCE — a
truncation, not a précis. At 10x roughly 4,600 of 5,500 shown concepts render
at that level, so for most of a review the truncation IS the review, and a
first sentence like "The course lasts 180 hours" carries none of the concept.

This writes a genuine standalone sentence per concept and caches it in
data/oneline_<collection>.json. precompute.py merges the cache in; nothing else
changes shape. Re-running is cheap: an entry is regenerated only if the source
summary changed (tracked by hash), so an interrupted run resumes.

Concurrency matters here — 13k concepts serially is hours. Threads are fine:
the work is entirely network-bound.

Usage:
    python summarize.py --collection c [--workers 12] [--limit N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

MODEL = "gpt-4o-mini"

# Narration about the lecture rather than the subject. ~36% of C summaries and
# ~40% of C++ ones open this way, because the distill stage described what the
# speaker was doing. On a study card it is pure noise: you want the fact, not
# the fact that someone once said it.
LEADIN = re.compile(
    r"^\s*(the\s+(speaker|instructor|segment|lecture|video|section|discussion"
    r"|text|passage|content|author|presenter)"
    r"|this\s+(concept|section|segment|lecture|part|topic|example)"
    r"|in\s+this\s+(section|segment|lecture|video|part)"
    r"|it\s+is\s+(discussed|explained|mentioned)|here\s*,)",
    re.I,
)
NARRATION = re.compile(
    r"\b(discusses|discussed|explains|explained|mentions|mentioned|emphasi[sz]es"
    r"|highlights|covers|introduces|demonstrates)\b",
    re.I,
)

SUMMARY_PROMPT = (
    "Rewrite the notes to describe the SUBJECT, not the lecture.\n"
    "Remove narration such as 'The speaker explains that X', 'The segment "
    "discusses X', 'They mention X' — state X directly as fact.\n"
    "Keep every technical detail, all function names, types, keywords and code "
    "references exactly as written. Do not add anything not present. Keep "
    "roughly the same length; do not compress.\n"
    "Output the rewritten notes as plain prose only. Do NOT repeat the "
    "CONCEPT or NOTES labels, and do not restate the concept title."
)

# The model likes to mirror the input's labelling back at us. Asking it not to
# helps but is not reliable, so strip the scaffolding deterministically too.
ECHOED_LABELS = re.compile(
    r"^\s*(?:CONCEPT\s*:.*?\n+)?\s*(?:NOTES?\s*:\s*)", re.I | re.S
)


def clean_reply(text: str) -> str:
    out = ECHOED_LABELS.sub("", text or "", count=1).strip()
    return out.strip('"').strip()

PROMPT = (
    "Compress the notes into ONE sentence for a study card.\n"
    "Requirements: a complete sentence that stands on its own without the "
    "title; state what the thing IS or DOES, not that the lecture discussed "
    "it; keep technical terms, function names and types exactly as written; "
    "at most 35 words; no lead-ins like 'This concept' or 'The speaker'.\n"
    "Return only the sentence."
)


def digest(text: str) -> str:
    return hashlib.md5((text or "").encode("utf-8")).hexdigest()[:16]


def load_cache(path: Path) -> dict[str, dict]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def main() -> int:
    here = Path(__file__).resolve().parent

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--collection", required=True)
    ap.add_argument(
        "--field",
        choices=("oneline", "summary"),
        default="oneline",
        help="oneline: write a one-sentence precis. summary: strip lecture "
        "narration from the full notes (only those that contain it).",
    )
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--limit", type=int, default=None, help="for a smoke test")
    args = ap.parse_args()

    load_dotenv(here / ".env")
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print(f"OPENAI_API_KEY not set — put it in {here / '.env'} or export it",
              file=sys.stderr)
        return 1
    client = OpenAI(api_key=key, timeout=60.0, max_retries=4)

    src = here / "data" / f"recall_{args.collection}.json"
    if not src.exists():
        print(f"Run precompute.py first — no {src}", file=sys.stderr)
        return 1
    concepts = json.loads(src.read_text(encoding="utf-8"))

    cache_path = here / "data" / f"{args.field}_{args.collection}.json"
    cache = load_cache(cache_path)

    def needs(c: dict) -> bool:
        text = (c.get("summary") or "").strip()
        if not text:
            return False
        if cache.get(c["canonical_concept_id"], {}).get("h") == digest(text):
            return False
        # Rewriting a summary that reads cleanly risks changing it for nothing,
        # so only touch the ones that actually narrate.
        if args.field == "summary":
            return bool(LEADIN.search(text) or NARRATION.search(text))
        return True

    todo = [c for c in concepts if needs(c)]
    cached = len(concepts) - len(todo)
    if args.limit:
        todo = todo[: args.limit]

    print(
        f"[{args.collection}] {len(concepts)} concepts, "
        f"{cached} cached, {len(todo)} to write",
        flush=True,
    )
    if not todo:
        return 0

    lock = threading.Lock()
    done = [0]
    failed = [0]
    started = time.time()

    def work(c: dict) -> None:
        summary = c["summary"]
        instruction = SUMMARY_PROMPT if args.field == "summary" else PROMPT
        try:
            reply = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {
                        "role": "user",
                        "content": f"{instruction}\n\nCONCEPT: {c['concept']}\n\nNOTES: {summary}",
                    }
                ],
                temperature=0.2,
            )
            text = clean_reply(reply.choices[0].message.content or "")
        except Exception as exc:  # noqa: BLE001 - one bad concept must not kill the run
            with lock:
                failed[0] += 1
                if failed[0] <= 5:
                    print(f"  ! {c['canonical_concept_id']}: {exc}", flush=True)
            return
        if not text:
            return
        with lock:
            cache[c["canonical_concept_id"]] = {"h": digest(summary), "text": text}
            done[0] += 1
            n = done[0]
            if n % 250 == 0 or n == len(todo):
                rate = n / max(1e-6, time.time() - started)
                left = (len(todo) - n) / max(1e-6, rate)
                print(
                    f"  {n}/{len(todo)}  {rate*60:.0f}/min  ~{left/60:.0f} min left",
                    flush=True,
                )
                cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, todo))

    cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    print(f"[{args.collection}] wrote {done[0]}, failed {failed[0]} -> {cache_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
