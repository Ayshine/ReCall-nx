import { useState } from "react";

// Multi-select board of distilled sources. Click a card to toggle it into the
// active review/quiz scope; "+ Add source" pulls in courses others distilled
// (they arrive as "distilling…" until their notes ingest into the KB).
export function SourceBoard({
  board,
  available,
  selected,
  conceptCount,
  onToggle,
  onAdd,
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="panel">
      <div className="board-head">
        <p className="section-title" style={{ margin: 0 }}>
          Sources
        </p>
        <span className="muted" style={{ fontSize: 13 }}>
          Click to include in review &amp; quizzes
        </span>
      </div>

      <div className="board">
        {board.map((s) => {
          const n = conceptCount(s.id);
          const ready = s.hasData && n > 0;
          const on = selected.includes(s.id);
          return (
            <button
              key={s.id}
              className={`source-card ${on ? "on" : ""} ${ready ? "" : "pending"}`}
              onClick={() => ready && onToggle(s.id)}
              disabled={!ready}
              title={ready ? "Toggle in scope" : "Still distilling"}
            >
              <span className="source-check">{on ? "✓" : ""}</span>
              <span className={`source-label src-${s.id}`}>{s.label}</span>
              <span className="source-meta">
                {ready ? (
                  <>
                    {n} concepts · {s.hours}h
                  </>
                ) : (
                  <>distilling… · {s.hours}h</>
                )}
              </span>
              <span className="source-author">@{s.author}</span>
            </button>
          );
        })}

        <button
          className="source-card add"
          onClick={() => setAdding((a) => !a)}
          title="Add a source others distilled"
        >
          <span className="plus">＋</span>
          <span className="source-meta">Add source</span>
        </button>
      </div>

      {adding && (
        <div className="add-panel">
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Courses others have distilled:
          </p>
          {available.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Nothing new right now — freshly distilled courses show up here.
            </p>
          ) : (
            <div className="add-list">
              {available.map((s) => (
                <div key={s.id} className="add-row">
                  <div>
                    <b>{s.label}</b>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {" "}
                      · {s.hours}h · @{s.author}
                    </span>
                  </div>
                  <button
                    className="btn"
                    onClick={() => {
                      onAdd(s);
                      if (available.length === 1) setAdding(false);
                    }}
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
