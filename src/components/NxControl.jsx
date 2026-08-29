import {
  clampN,
  planReview,
  budgetHoursFor,
  originalHoursFor,
  fmtHours,
} from "../lib/nx.js";

const PRESETS = [
  { n: 2, label: "2×" },
  { n: 5, label: "5×" },
  { n: 10, label: "10×", isDefault: true },
  { n: 20, label: "20×" },
  { n: 40, label: "40×" },
];

export function NxControl({ n, onN, selection, concepts }) {
  const plan = planReview(concepts, n);
  const budget = budgetHoursFor(selection, n);
  const original = originalHoursFor(selection);

  return (
    <div className="panel">
      <p className="section-title">Review speed</p>
      <div className="nx-wrap">
        <div>
          <div className="nx-readout">
            <span className="nx-big">{n}</span>
            <span className="nx-x">× speed</span>
          </div>
          <input
            className="slider"
            type="range"
            min="1"
            max="60"
            value={n}
            onChange={(e) => onN(clampN(+e.target.value))}
            aria-label="Review speed multiplier"
          />
          <div className="nx-ticks">
            <span>1× · full</span>
            <span>60× · flash</span>
          </div>
          <div className="presets">
            {PRESETS.map((p) => (
              <button
                key={p.n}
                className={n === p.n ? "on" : ""}
                onClick={() => onN(p.n)}
              >
                {p.label}
                {p.isDefault && <span className="default-tag">default</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat">
            <div className="k">Full course</div>
            <div className="v">
              {original}
              <small> hrs</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Review budget</div>
            <div className="v" style={{ color: "var(--accent)" }}>
              {fmtHours(budget)}
            </div>
          </div>
          <div className="stat">
            <div className="k">Depth mix</div>
            <div className="v">
              <span className="tier-pill">{plan.tier.label}</span>
              <small>
                {" "}
                {plan.levels.summary.toLocaleString()} full ·{" "}
                {plan.levels.code.toLocaleString()} line+code ·{" "}
                {plan.levels.oneline.toLocaleString()} line
                {plan.levels.headline > 0
                  ? ` · ${plan.levels.headline.toLocaleString()} title`
                  : ""}
              </small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Concepts kept</div>
            <div className="v">
              {plan.keptCount}
              <small>
                {" "}
                / {concepts.length}
                {plan.droppedCount > 0 ? ` · −${plan.droppedCount}` : ""}
                {` · ${plan.cards.length.toLocaleString()} cards`}
              </small>
            </div>
          </div>
        </div>
      </div>

      <div className="note-banner">
        At <b>{n}×</b>, your {original}-hour course compresses to a{" "}
        <b>{fmtHours(budget)}</b> review, and the material is fitted to it:
        every kept concept appears, with the budget spent giving the most
        foundational ones full notes and code and the rest a single line.
        Speeding up shrinks the budget, so fewer get the full treatment.
      </div>
    </div>
  );
}
