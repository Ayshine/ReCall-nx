import { useEffect, useState } from "react";
import { pickQuizConcept, gradeAnswer } from "../lib/api.js";
import { Citation } from "./Citation.jsx";
import { inlineCode } from "./Rich.jsx";

// The app asks; you answer; it grades you against the notes DB (+ optional
// web-LLM check). This is the active-recall test — the reverse of the Ask tab.
export function QuizMode({ selection, onOpen }) {
  const [concept, setConcept] = useState(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
  const [grading, setGrading] = useState(false);
  const [useLLM, setUseLLM] = useState(true);
  const [kind, setKind] = useState("recall");
  const [choice, setChoice] = useState(null); // selected mcq option index
  const [runs, setRuns] = useState([]); // past scores this session

  const nextQuestion = async (excludeId, forKind = kind) => {
    setResult(null);
    setAnswer("");
    setChoice(null);
    setConcept(null);
    const c = await pickQuizConcept(selection, excludeId, forKind);
    setConcept(c);
  };

  // Fresh question when the tab opens or the sources in scope change.
  useEffect(() => {
    nextQuestion();
    setRuns([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(selection) ? selection.join(",") : selection, kind]);

  const isMcq = concept?.kind === "mcq";

  const submit = async () => {
    if (!concept || grading) return;
    if (isMcq ? choice === null : !answer.trim()) return;
    setGrading(true);
    const r = await gradeAnswer(concept, isMcq ? choice : answer, useLLM);
    setResult(r);
    setRuns((prev) => [...prev, r.score]);
    setGrading(false);
  };

  const avg =
    runs.length > 0
      ? Math.round(runs.reduce((a, b) => a + b, 0) / runs.length)
      : null;

  if (!concept) {
    return <div className="panel empty">Loading a question…</div>;
  }

  const verdictClass =
    result?.verdict === "Solid"
      ? "got"
      : result?.verdict === "Partial"
      ? "foggy"
      : "miss";

  return (
    <>
      <div className="panel">
        <div className="board-head">
          <p className="section-title" style={{ margin: 0 }}>
            Quiz me · {concept.collection.toUpperCase()}
          </p>
          {avg !== null && (
            <span className="muted" style={{ fontSize: 13 }}>
              {runs.length} answered · avg {avg}%
            </span>
          )}
        </div>

        <div className="presets kind-presets">
          <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>
            Question type
          </span>
          {[
            ["recall", "Open recall"],
            ["mcq", "Multiple choice"],
            ["code", "Code"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={kind === id ? "on" : ""}
              onClick={() => setKind(id)}
            >
              {label}
            </button>
          ))}
          {kind !== "recall" && concept.kind === "recall" && (
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
              no {kind} question for this concept — open recall instead
            </span>
          )}
        </div>

        <p className="quiz-q">{inlineCode(concept.question)}</p>

        {concept.kind === "code" && concept.code && (
          <pre className="code quiz-code">{concept.code}</pre>
        )}

        {isMcq ? (
          <ul className="mcq-list">
            {concept.options.map((opt, i) => {
              const chosen = choice === i;
              const reveal = !!result;
              const right = i === concept.answerIndex;
              const cls = reveal
                ? right
                  ? "right"
                  : chosen
                  ? "wrong"
                  : ""
                : chosen
                ? "chosen"
                : "";
              return (
                <li key={i}>
                  <button
                    className={`mcq-option ${cls}`}
                    disabled={reveal}
                    onClick={() => setChoice(i)}
                  >
                    <span className="mcq-mark">
                      {reveal && right ? "✓" : reveal && chosen ? "✗" : ""}
                    </span>
                    {inlineCode(opt)}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <textarea
            className="quiz-input"
            rows={5}
            value={answer}
            disabled={!!result}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={
              concept.kind === "code"
                ? "Explain what the code does — from memory, don't peek."
                : "Answer from memory — don't peek. Then I'll grade you against the notes."
            }
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
          />
        )}

        <div className="quiz-controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={useLLM}
              onChange={(e) => setUseLLM(e.target.checked)}
            />
            Also cross-check with web-LLM
          </label>
          {!result ? (
            <button
              className="btn primary"
              onClick={submit}
              disabled={(isMcq ? choice === null : !answer.trim()) || grading}
            >
              {grading ? "Grading…" : "Grade me"}
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => nextQuestion(concept.canonical_concept_id)}
            >
              Next question →
            </button>
          )}
        </div>
      </div>

      {result && (
        <div className="panel">
          <div className="quiz-score-head">
            <div className={`quiz-score ${verdictClass}`}>{result.score}%</div>
            <div>
              <div className={`quiz-verdict ${verdictClass}`}>
                {result.verdict}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {result.points.filter((p) => p.hit).length} of{" "}
                {result.points.length} key points recalled
              </div>
            </div>
          </div>

          <ul className="point-list">
            {result.points.map((p, i) => (
              <li key={i} className={p.hit ? "hit" : "miss"}>
                <span className="mark">{p.hit ? "✓" : "✗"}</span>
                {inlineCode(p.point)}
              </li>
            ))}
          </ul>

          {result.llmNote && <div className="llm-note">{result.llmNote}</div>}

          <div className="model-answer">
            <p className="section-title" style={{ marginBottom: 8 }}>
              From your notes
            </p>
            <p className="answer" style={{ marginTop: 0 }}>
              {inlineCode(result.modelAnswer)}
            </p>
            <div style={{ marginTop: 10 }}>
              <Citation {...result.citation} onOpen={onOpen} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
