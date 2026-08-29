// Render text that may contain `inline code` spans (single backticks) into React
// nodes. Keeps the notes readable without pulling in a full markdown parser.
export function inlineCode(text, keyPrefix = "t") {
  const parts = String(text).split("`");
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <code className="inline" key={`${keyPrefix}${i}`}>
        {p}
      </code>
    ) : (
      <span key={`${keyPrefix}${i}`}>{p}</span>
    )
  );
}
