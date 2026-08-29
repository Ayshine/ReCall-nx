import { useEffect, useMemo, useRef, useState } from "react";
import { SourceBoard } from "./components/SourceBoard.jsx";
import { NxControl } from "./components/NxControl.jsx";
import { ReviewMode } from "./components/ReviewMode.jsx";
import { QAMode } from "./components/QAMode.jsx";
import { QuizMode } from "./components/QuizMode.jsx";
import { fetchConcepts, fetchCollections, USE_MOCK } from "./lib/api.js";
import { SOURCES, AVAILABLE_SOURCES } from "./data/sources.js";

const TABS = [
  { id: "review", label: "Review" },
  { id: "ask", label: "Ask recall" },
  { id: "quiz", label: "Quiz me" },
];

export default function App() {
  const [board, setBoard] = useState(SOURCES);
  const [available, setAvailable] = useState(AVAILABLE_SOURCES);
  const [selected, setSelected] = useState(["c"]); // active source ids
  const [n, setN] = useState(10); // default review speed = 10× (user preference)
  const [tab, setTab] = useState("review");
  const [concepts, setConcepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const selKey = selected.join(",");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchConcepts(selected).then((items) => {
      if (alive) {
        setConcepts(items);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  // Real per-collection counts from the backend (mock-derived in mock mode), so
  // the board reflects what has actually been precomputed rather than sample data.
  const [counts, setCounts] = useState({});
  useEffect(() => {
    fetchCollections()
      .then((r) => setCounts(r.counts ?? {}))
      .catch(() => setCounts({}));
  }, []);
  const conceptCount = (id) => counts[id] ?? 0;

  const toggleSource = (id) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        // keep at least one source selected
        return prev.length === 1 ? prev : prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  };

  const addSource = (s) => {
    setBoard((prev) => (prev.some((b) => b.id === s.id) ? prev : [...prev, s]));
    setAvailable((prev) => prev.filter((a) => a.id !== s.id));
  };

  const onOpen = (cite) => {
    setToast(
      `▶ ${cite.collection.toUpperCase()} · ${cite.source_video} @ ${cite.source_timestamp}`
    );
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const total = useMemo(() => concepts.length, [concepts]);
  const scopeLabel = selected
    .map((id) => board.find((b) => b.id === id)?.label ?? id)
    .join(" + ");

  return (
    <div className="app">
      <div className="masthead">
        <div>
          <div className="brand">
            <h1>ReCall</h1>
            <span className="nx">{n}×</span>
          </div>
          <p className="tagline">
            Review your distilled course at speed, then test whether it stuck.
          </p>
        </div>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <SourceBoard
        board={board}
        available={available}
        selected={selected}
        conceptCount={conceptCount}
        onToggle={toggleSource}
        onAdd={addSource}
      />
      <p className="muted" style={{ fontSize: 13, margin: "10px 2px 18px" }}>
        {loading
          ? "Loading notes…"
          : `${scopeLabel} in scope · ${total} concepts`}
      </p>

      {tab === "review" && !loading && (
        <>
          <NxControl n={n} onN={setN} selection={selected} concepts={concepts} />
          <div style={{ height: 18 }} />
          <ReviewMode
            concepts={concepts}
            n={n}
            selection={selected}
            onOpen={onOpen}
            onDone={() => setTab("quiz")}
          />
        </>
      )}

      {tab === "ask" && <QAMode selection={selected} onOpen={onOpen} />}

      {tab === "quiz" && <QuizMode selection={selected} onOpen={onOpen} />}

      {USE_MOCK && (
        <p className="muted center" style={{ fontSize: 12, marginTop: 26 }}>
          Running on sample notes. Point{" "}
          <code className="inline">src/lib/api.js</code> at the FastAPI backend to
          use your real <code className="inline">.kb</code> vector DB.
        </p>
      )}

      {toast && (
        <div className="toast">{toast}</div>
      )}
    </div>
  );
}
