import { useState } from "react";
import { askQuestion } from "../lib/api.js";
import { Citation, renderAnswer } from "./Citation.jsx";

const SUGGESTIONS = {
  c: ["How does malloc ownership work?", "What is array-to-pointer decay?", "Explain pointers and addresses"],
  cpp: ["How does move semantics work?", "What is RAII?", "Explain templates"],
};

// Blend suggestions from every selected source, keeping a tidy handful.
function suggestionsFor(selection) {
  const ids = Array.isArray(selection) ? selection : [selection];
  const out = [];
  ids.forEach((id) => (SUGGESTIONS[id] ?? []).forEach((q) => out.push(q)));
  return (out.length ? out : Object.values(SUGGESTIONS).flat()).slice(0, 4);
}

export function QAMode({ selection, onOpen }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [graded, setGraded] = useState(false);
  const [tally, setTally] = useState({ got: 0, foggy: 0, miss: 0 });

  const run = async (q) => {
    const question = (q ?? query).trim();
    if (!question) return;
    setQuery(question);
    setLoading(true);
    setResult(null);
    setGraded(false);
    const r = await askQuestion(question, selection);
    setResult(r);
    setLoading(false);
  };

  const grade = (key) => {
    setTally((t) => ({ ...t, [key]: t[key] + 1 }));
    setGraded(true);
  };

  const total = tally.got + tally.foggy + tally.miss;
  const pct = total ? Math.round((tally.got / total) * 100) : 0;

  return (
    <>
      <div className="panel">
        <p className="section-title">Ask your recall</p>
        <form
          className="ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask anything from the course — answered only from your notes…"
            aria-label="Question"
          />
          <button className="btn primary" type="submit" disabled={loading}>
            {loading ? "Thinking…" : "Ask"}
          </button>
        </form>
        <div className="suggest">
          {suggestionsFor(selection).map((s) => (
            <button key={s} className="chip" onClick={() => run(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {result && (
        <div className="panel">
          <div className={`answer ${result.covered ? "" : "notcovered"}`}>
            {result.covered
              ? renderAnswer(result.answer, onOpen)
              : result.answer}
          </div>

          {result.citations?.length > 0 && (
            <div className="cite-list">
              {result.citations.map((c, i) => (
                <Citation key={i} {...c} onOpen={onOpen} />
              ))}
            </div>
          )}

          {result.covered && !graded && (
            <div className="grade">
              <p>Before you read it — how well did you actually recall this?</p>
              <div className="grade-btns">
                <button className="miss" onClick={() => grade("miss")}>
                  ✗ Blank
                </button>
                <button className="foggy" onClick={() => grade("foggy")}>
                  ~ Foggy
                </button>
                <button className="got" onClick={() => grade("got")}>
                  ✓ Nailed it
                </button>
              </div>
            </div>
          )}
          {graded && (
            <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
              Logged. Ask another to keep testing.
            </p>
          )}
        </div>
      )}

      {total > 0 && (
        <div className="panel">
          <p className="section-title">Recall score · {pct}% solid</p>
          <div className="recall-summary">
            <div className="recall-stat">
              <div className="n got">{tally.got}</div>
              <div className="l">Nailed</div>
            </div>
            <div className="recall-stat">
              <div className="n foggy">{tally.foggy}</div>
              <div className="l">Foggy</div>
            </div>
            <div className="recall-stat">
              <div className="n miss">{tally.miss}</div>
              <div className="l">Blank</div>
            </div>
          </div>
          <p className="muted" style={{ marginTop: 14, marginBottom: 0, fontSize: 13 }}>
            Foggy and blank concepts are the ones to re-review — bump the speed
            down and run them again.
          </p>
        </div>
      )}
    </>
  );
}
