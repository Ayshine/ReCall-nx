# ReCall-nx

Review your distilled video course at **n× speed**, then **test whether it stuck**.

ReCall-nx is the front end over a `.kb/` vector DB of distilled course notes
(produced by a separate video-distilling pipeline). You watched ~160 hours of C
and ~160 hours of C++ lectures once; ReCall-nx lets you re-review the distilled
notes at whatever pace you choose, then quizzes your recall with answers cited
back to the exact video + timestamp.

## The n× idea

At **1×** a review would take as long as the original course. At **n×** your
review budget is `original_hours / n`:

| Speed | Budget (160h course) | Depth | Shows |
|------:|:---------------------|:------|:------|
| 2×    | 80h                  | Deep  | every concept, full notes + code |
| 10× (default) | 16h          | Standard | important concepts, summary + code |
| 20–40× | 8h → 4h             | Skim  | key concepts, one line each |
| 40×+  | < 4h                 | Flash | headlines only |

Speeding up raises the importance floor (low-priority concepts drop first) and
shortens the per-card pacing timer, so the whole review fits the budget.

## Sources

The **source board** lists every course in your KB. Click a card to toggle it
into scope — review and quizzes span all selected sources at once (multi-select).
**"+ Add source"** pulls in courses other people distilled; they appear as
"distilling…" until their notes finish ingesting into the DB.

## Three modes

- **Review** — set the speed and step (or auto-pace) through concepts at the
  chosen depth. Timestamps are clickable citations.
- **Ask recall** (you ask) — ask questions answered **only** from your notes,
  with inline `[collection/video @ hh:mm:ss]` citations. Self-grade each answer
  (Nailed / Foggy / Blank).
- **Quiz me** (we ask) — the app generates a question from a source in scope;
  you type an answer from memory and it **grades you against the notes DB**,
  showing which key points you hit or missed, a model answer with citation, and
  a running score. Toggle **web-LLM cross-check** to also credit correct answers
  phrased differently than the notes (stubbed in mock mode; wire to a real
  LLM-judge / web-search model with the backend).

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

## Wiring the real backend

The UI currently runs on sample notes in `src/data/mockData.js`. To use the real
`.kb/` vector DB:

1. Stand up the FastAPI backend in [`backend/`](backend/)
   (`uv run uvicorn app:app --reload`) — it exposes `/search` and `/ask` over the
   distilled `.kb/` vector DB.
2. Set `USE_MOCK = false` in [`src/lib/api.js`](src/lib/api.js). The `/api/*`
   calls are already proxied to `http://localhost:8000` (see `vite.config.js`);
   `fetchConcepts` and `askQuestion` keep the same shapes, so no component
   changes are needed.

## Structure

```
src/
  lib/nx.js          the n× speed model (budget, depth tiers, concept planning)
  lib/api.js         data layer — mock today, FastAPI tomorrow (same interface):
                     fetchConcepts / askQuestion / pickQuizConcept / gradeAnswer
  data/mockData.js   sample notes (SearchResult shape) + quiz questions/keyPoints
  data/sources.js    the source registry (on-board + community-available)
  components/
    SourceBoard       multi-select source cards + add-from-community
    NxControl         speed slider + budget/depth/concept stats
    ReviewMode        paced concept runner
    QAMode            recall Q&A (you ask) + self-grading
    QuizMode          active-recall quiz (we ask) + grading against the notes
    Citation          [collection/video @ ts] chips + answer renderer
```
