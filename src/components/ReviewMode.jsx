import { useEffect, useState } from "react";
import {
  planReview,
  fmtClock,
  fmtDuration,
  fmtHours,
  PACE_OPTIONS,
  DEFAULT_CARD_SECONDS,
} from "../lib/nx.js";
import { Citation } from "./Citation.jsx";
import { inlineCode } from "./Rich.jsx";

function Importance({ level }) {
  return (
    <span className="imp" title={`Importance ${level}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= level ? "on" : ""} />
      ))}
    </span>
  );
}

// Code is collapsed by default. A card can carry a dozen concepts, and a run of
// expanded snippets buries the prose between them — but the code is still the
// part worth studying, so it is one click away and can be opened card-wide.
// Slide screenshots. Collapsed like code by default — a card can hold a dozen
// concepts and a wall of full-width slides buries everything between them.
// A collapsed block still has to LOOK like a block. Earlier the collapsed
// state was a bare text link that vanished into the prose, so a card with
// eight snippets looked like a card with none. The header bar stays put and
// carries the toggle in its own corner.
function BlockShell({ label, open, onToggle, children }) {
  return (
    <div className={`codeblock ${open ? "open" : ""}`}>
      <div className="codeblock-head">
        <span className="codeblock-label">{label}</span>
        <button
          className="codeblock-toggle"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? "Collapse" : "Expand"}
        >
          <span className="chev">{open ? "▾" : "▸"}</span>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && children}
    </div>
  );
}

function SlideBlock({ collection, images, open, onToggle }) {
  const n = images.length;
  return (
    <BlockShell
      label={`slide · ${n} image${n === 1 ? "" : "s"}`}
      open={open}
      onToggle={onToggle}
    >
      {images.map((src) => (
        <img
          key={src}
          className="slide-shot"
          loading="lazy"
          alt={`Slide for this concept (${src.split("/").pop()})`}
          src={`/api/slides/${encodeURIComponent(collection)}/${encodeURIComponent(
            src.split("/").pop()
          )}`}
        />
      ))}
    </BlockShell>
  );
}

function CodeBlock({ code, language, open, onToggle }) {
  const lines = code.split("\n").length;
  return (
    <BlockShell
      label={`code · ${lines} line${lines === 1 ? "" : "s"}${language ? ` · ${language}` : ""}`}
      open={open}
      onToggle={onToggle}
    >
      <pre className="code">{code}</pre>
    </BlockShell>
  );
}

function ConceptBody({ c, detail, onOpen, codeOpen, onToggleCode }) {
  // A concept shown at one line does not deserve the same furniture as a full
  // note: a big heading and a full meta row above a single sentence reads as a
  // stranded fragment. Brief concepts render as a tight list item instead, so a
  // card looks like a few sections followed by a run of one-liners.
  if (detail === "headline" || detail === "oneline" || detail === "code") {
    return (
      <div
        className={`concept brief${
          detail === "code" && (c.code || c.images?.length) ? " has-code" : ""
        }`}
      >
        <p className="brief-line">
          <b className="brief-title">{c.concept}</b>
          {detail === "headline" ? (
            <> — {inlineCode(c.headline)}</>
          ) : (
            <> — {inlineCode(c.oneline)}</>
          )}
        </p>
        {detail === "code" && c.code && (
          <CodeBlock
            code={c.code}
            language={c.code_language}
            open={codeOpen}
            onToggle={onToggleCode}
          />
        )}
        {detail === "code" && !c.code && c.images?.length > 0 && (
          <SlideBlock
            collection={c.collection}
            images={c.images}
            open={codeOpen}
            onToggle={onToggleCode}
          />
        )}
        <div className="brief-meta">
          <Citation
            collection={c.collection}
            source_video={c.source_video}
            source_timestamp={c.source_timestamp}
            onOpen={onOpen}
          />
          <Importance level={c.importance} />
        </div>
      </div>
    );
  }

  return (
    <div className="concept">
      <div className="meta">
        <span className={`badge ${c.collection}`}>{c.source_video}</span>
        <Citation
          collection={c.collection}
          source_video={c.source_video}
          source_timestamp={c.source_timestamp}
          onOpen={onOpen}
        />
        <Importance level={c.importance} />
      </div>

      <h2>{c.concept}</h2>

      {detail === "headline" && (
        <p className="headline">{inlineCode(c.headline)}</p>
      )}

      {detail === "oneline" && <p className="oneline">{inlineCode(c.oneline)}</p>}

      {(detail === "summary" || detail === "full") && (
        <>
          <p className="body">{inlineCode(c.summary)}</p>
          {c.code &&
            (c.code_repeat_of ? (
              <p className="code-repeat muted">
                Same snippet as shown earlier — not repeated.
              </p>
            ) : (
              <CodeBlock
                code={c.code}
                language={c.code_language}
                open={codeOpen}
                onToggle={onToggleCode}
              />
            ))}
          {c.images?.length > 0 && (
            <SlideBlock
              collection={c.collection}
              images={c.images}
              open={codeOpen}
              onToggle={onToggleCode}
            />
          )}
        </>
      )}

      {detail === "full" && c.depends_on?.length > 0 && (
        <div className="depends">
          <b>Builds on:</b> {c.depends_on.join(", ")}
        </div>
      )}
    </div>
  );
}

export function ReviewMode({ concepts, n, selection, onOpen, onDone }) {
  const [pace, setPace] = useState(String(DEFAULT_CARD_SECONDS));
  const [idx, setIdx] = useState(0);
  const plan = planReview(
    concepts,
    n,
    PACE_OPTIONS.find((o) => o.id === pace)?.seconds ?? DEFAULT_CARD_SECONDS
  );
  const paceOpt =
    PACE_OPTIONS.find((o) => o.id === pace) ??
    PACE_OPTIONS.find((o) => o.seconds === DEFAULT_CARD_SECONDS);
  const cards = plan.cards;
  const total = cards.length;
  const current = cards[Math.min(idx, total - 1)];
  // Pace the card on its ACTUAL reading time, not the target — the last card
  // of a lecture is often short, and parking on it wastes the budget.
  const perCard = Math.round(current?.seconds ?? paceOpt.seconds);
  // Concepts on this card that actually render a snippet.
  const cardCodeIds = (current?.items ?? [])
    .filter(
      (c) =>
        ((c.code && !c.code_repeat_of) || c.images?.length > 0) &&
        ["code", "summary", "full"].includes(plan.levelOf(c))
    )
    .map((c) => c.canonical_concept_id);
  const planKey = `${selection}:${plan.tier.id}:${pace}`;

  const [playing, setPlaying] = useState(false);
  const [openCode, setOpenCode] = useState(() => new Set());
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(false);

  // Rebuild the run whenever the collection or depth tier changes.
  useEffect(() => {
    setIdx(0);
    setElapsed(0);
    setPlaying(false);
    setDone(false);
  }, [planKey]);

  // Snippets opened on one card should not stay open on the next.
  useEffect(() => {
    setOpenCode(new Set());
  }, [idx, planKey]);

  // Tick the pacing clock while playing.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setElapsed((e) => e + 0.1), 100);
    return () => clearInterval(t);
  }, [playing, idx]);

  // Auto-advance when a card's time budget is spent.
  useEffect(() => {
    if (!playing) return;
    if (elapsed >= perCard) {
      if (idx < total - 1) {
        setIdx(idx + 1);
        setElapsed(0);
      } else {
        setPlaying(false);
        setDone(true);
      }
    }
  }, [elapsed, playing, idx, total, perCard]);

  if (total === 0) {
    return <div className="panel empty">No concepts at this speed. Slow down.</div>;
  }

  const go = (next) => {
    const clamped = Math.max(0, Math.min(total - 1, next));
    setIdx(clamped);
    setElapsed(0);
    setDone(false);
  };

  if (done) {
    return (
      <div className="panel center">
        <h2 style={{ marginTop: 8 }}>Review complete 🎉</h2>
        <p className="muted">
          You paced through {total} concept{total === 1 ? "" : "s"} at {n}×.
          Now test whether it stuck.
        </p>
        <div
          className="btn-row"
          style={{ justifyContent: "center", marginTop: 18 }}
        >
          <button className="btn ghost" onClick={() => go(0)}>
            ↺ Review again
          </button>
          <button className="btn primary" onClick={onDone}>
            Ask your recall →
          </button>
        </div>
      </div>
    );
  }

  const overallPct = ((idx + (playing ? elapsed / perCard : 0)) / total) * 100;
  const pacePct = Math.min(100, (elapsed / perCard) * 100);

  return (
    <div className="panel">
      <div className="runner-top">
        <span className="muted">
          Card <b style={{ color: "var(--text)" }}>{idx + 1}</b> /{" "}
          {total.toLocaleString()}
          <span style={{ margin: "0 8px" }}>·</span>
          {current?.items.length} concept
          {current?.items.length === 1 ? "" : "s"}
          <span style={{ margin: "0 8px" }}>·</span>
          <span className="tier-pill">{plan.tier.label}</span>
        </span>
        <span className="muted" style={{ fontFamily: "var(--mono)" }}>
          {playing
            ? `${fmtClock(perCard - elapsed)} left`
            : `~${fmtDuration(perCard)} to read`}
        </span>
      </div>

      <div className="presets pace-presets">
        <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>
          Material per card
        </span>
        {PACE_OPTIONS.map((o) => (
          <button
            key={o.id}
            className={pace === o.id ? "on" : ""}
            onClick={() => setPace(o.id)}
            title={`About ${o.label} of reading on each card`}
          >
            {o.label}
          </button>
        ))}
        {cardCodeIds.length > 0 && (
          <button
            className="code-all"
            onClick={() =>
              setOpenCode((prev) =>
                prev.size >= cardCodeIds.length ? new Set() : new Set(cardCodeIds)
              )
            }
          >
            {openCode.size >= cardCodeIds.length
              ? "Collapse all"
              : `Expand all (${cardCodeIds.length})`}
          </button>
        )}
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          {total.toLocaleString()} cards · walkthrough{" "}
          {fmtHours(plan.spentSeconds / 3600)} of{" "}
          {fmtHours(plan.budgetSeconds / 3600)} budget
        </span>
      </div>

      <div className="progress">
        <i style={{ width: `${overallPct}%` }} />
      </div>

      <div style={{ marginTop: 18 }}>
        {current?.items.map((c, i) => (
          <div key={c.canonical_concept_id} className={i > 0 ? "card-next" : ""}>
            <ConceptBody
              c={c}
              detail={plan.levelOf(c)}
              onOpen={onOpen}
              codeOpen={openCode.has(c.canonical_concept_id)}
              onToggleCode={() =>
                setOpenCode((prev) => {
                  const next = new Set(prev);
                  next.has(c.canonical_concept_id)
                    ? next.delete(c.canonical_concept_id)
                    : next.add(c.canonical_concept_id);
                  return next;
                })
              }
            />
          </div>
        ))}
      </div>

      {playing && (
        <div className="pace-bar">
          <i style={{ width: `${pacePct}%` }} />
        </div>
      )}

      <div className="runner-controls">
        <div className="btn-row">
          <button
            className="btn ghost"
            onClick={() => go(idx - 1)}
            disabled={idx === 0}
          >
            ← Prev
          </button>
          <button
            className="btn primary"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              if (idx < total - 1) go(idx + 1);
              else setDone(true);
            }}
          >
            {idx < total - 1 ? "Next →" : "Finish ✓"}
          </button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          Auto-paced to fit the {n}× budget
        </span>
      </div>
    </div>
  );
}
