# ReCall-nx backend

Serves the ReCall-nx UI from the `.kb/` Qdrant vector DB built by the upstream
video-distilling pipeline. Two layers with very different costs:

| Route | Cost | Source |
|---|---|---|
| `GET /collections` | free | precomputed files on disk |
| `GET /concepts?collection=c,cpp` | free | `data/recall_<collection>.json` |
| `GET /search?q=…&collection=c&k=8` | 1 embedding call | live hybrid retrieval |
| `GET /ask?q=…&collection=c` | 1 embedding + 1 chat call | live RAG with citations |
| `GET /quiz/question?collection=c&id=…` | 1 chat call | question written from the merged notes |
| `GET /quiz/grade?collection=c&id=…&answer=…` | 1 chat call | LLM judge against the notes |

Quiz questions and grades are generated **on demand**. Pre-generating a question
for all 13,073 concepts would be ~11 hours of serial calls to serve a quiz that
shows one at a time; per-question it costs a fraction of a cent, and
`CachedLLMClient` makes a repeat of the same concept free.

Grading uses an LLM judge rather than keyword matching, so a correct paraphrase
scores. The judge is told to pick the 3-4 points most central to the concept and
to ignore incidental lecture examples — without that it grades on lecture
trivia, and a sound general answer scored 17% instead of 75% in testing. The
precomputed `keyPoints` remain as a fallback if the judge reply is unparseable.

## Division of labour

**The distiller pipeline owns the KB and the synthesis.** It turns videos into a
ready-to-use KB, and its `synthesize` step dedups those notes into
canonical concepts ordered by dependency (11,006 raw C notes → 6,542 concepts).
That is its artifact; nothing here recomputes it.

**ReCall-nx owns n×** — what a 2× or a 40× review actually shows. That is
`precompute.py`: importance banding, the depth fields each tier renders, and
the quiz fields. It reads `synthesis.json` and writes UI JSON. No LLM, no
vector DB, no synthesis logic.

The n× model needs `importance` and `order`, which the KB cannot provide:
importance is dependency in-degree, and ordering is a topological sort — both
only exist across a whole collection. When the pipeline processed lecture 5 it
had no way to know lecture 30 would depend on it.

Synthesis is far too slow to run per request, so it runs once and both its
output and the mapped UI JSON are served as static files.

### Importance

The obvious signal — dependency in-degree — does not work on this corpus. Of
6,542 C concepts only 94 declare any `depends_on`, and of 184 edges 81 dangle,
leaving ~103 usable edges. Ranking on that ties 99% of concepts at zero, so
percentile bands degenerate into alphabetical order by concept id. The
topological `order` is near-meaningless for the same reason (zero cycles were
found because there is barely a graph).

What does vary is **how many distinct lectures teach a concept** — 21% appear
in more than one, spread as wide as 18. Importance is therefore rule-based:

| Score | Rule |
|---|---|
| 5 | taught across 3+ lectures |
| 4 | taught across 2 lectures, or has a real dependency edge |
| 3 | one lecture, but repeated in it or carries pitfalls |
| 2 | one lecture, one mention, has a code snippet |
| 1 | one lecture, one mention, no code |

Rules rather than percentiles because 79% of concepts are a single mention in a
single lecture — an undifferentiated mass that fixed cutoffs would split
arbitrarily. Spread for C: `{5: 293, 4: 512, 3: 1240, 2: 3458, 1: 1039}`.

### Review order

`planReview` runs two phases: a **walkthrough** in course order (lecture, then
timestamp — the courses are cumulative), then a **priority pass** over the
concepts that outrank the floor. Importance decides what is shown, time decides
the sequence. The time budget is a displayed reference, not a cap.

### Derived fields

`headline`, `oneline`, `question` and `keyPoints` have no source in the KB and
are currently derived cheaply (concept name, first sentence, template, sentence
split + content words). They cost nothing and prove the pipeline end to end.
To upgrade them later, swap in `videodistill.review.quiz.generate_question` and
an LLM pass for headline/oneline — the JSON shape does not change.

## Data root

Everything shared lives under `$RECALL_DATA` (default
`~/Documents/dbs/recall-data`), not inside a pipeline repo:

```
recall-data/
  kb/                          the Qdrant store — the interface between distillers and this app
  synthesis/<collection>/      synthesis.json from `videodistill synthesize`
  media/<collection>/          slide screenshots, served via /slides
  profiles/<collection>.yaml   course vocabulary, used by the review layer
  languages/en/stopwords.txt
  cache/                       this app's own LLM cache
```

The vector DB is the boundary between the distillers and ReCall, so it does not
belong in either one's working tree. Reaching into the distiller repo's `.kb`
meant ReCall broke if that repo moved or was archived — long after its distilling
had finished.

## Setup

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install --no-deps /path/to/distiller-repo    # library only, not editable
```

`--no-deps` is deliberate: the KB and review layers need only qdrant-client,
openai, google-genai, pydantic and rank-bm25 — not faster-whisper, OpenCV or
onnxruntime. Keeps this env ~177 MB instead of ~554 MB.

Not `-e`: an editable install keeps reading the pipeline's source tree at
import time, which is the coupling this layout removes. Reinstall after
changing videodistill.

`OPENAI_API_KEY` comes from the environment, or `backend/.env` (gitignored).

## Run

Step 1 — synthesis, in the distiller repo (slow, LLM-backed, cached):

```bash
cd /path/to/distiller-repo && .venv/bin/videodistill synthesize --collection c --out synthesis/c
```

Step 2 — the n× mapping, here (fast, pure-stdlib, no API calls):

```bash
.venv/bin/python precompute.py --collection c
.venv/bin/uvicorn app:app --reload --port 8000
```

Then set `USE_MOCK = false` in [`../src/lib/api.js`](../src/lib/api.js) and run
`npm run dev`. Vite proxies `/api/*` to port 8000 (see `vite.config.js`).

## The .kb lock

Embedded Qdrant takes an **exclusive lock** on `.kb/`. Only one process may hold
it: while `app.py` is running, `precompute.py` and `videodistill kb search` will
fail to open the DB, and vice versa. Stop one before starting the other.
