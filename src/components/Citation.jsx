import { COLLECTION_LABEL } from "../lib/nx.js";
import { inlineCode } from "./Rich.jsx";

// A single [collection/video @ ts] citation chip. Clicking it would deep-link to
// the source video at the timestamp; with mock data we just surface the target.
export function Citation({ collection, source_video, source_timestamp, onOpen }) {
  const label = COLLECTION_LABEL[collection] ?? collection;
  return (
    <span
      className="cite"
      title={`Open ${source_video} at ${source_timestamp}`}
      onClick={() => onOpen?.({ collection, source_video, source_timestamp })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) =>
        e.key === "Enter" &&
        onOpen?.({ collection, source_video, source_timestamp })
      }
    >
      <span>
        {label} · {source_video}
      </span>
      <span className="ts">@ {source_timestamp}</span>
    </span>
  );
}

const CITE_RE = /\[([^/\]]+)\/([^@\]]+?)\s*@\s*([0-9:]+)\]/g;

// Render an answer string, converting inline [col/video @ ts] markers into chips.
export function renderAnswer(text, onOpen) {
  const nodes = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = CITE_RE.exec(text)) !== null) {
    if (m.index > last)
      nodes.push(...inlineCode(text.slice(last, m.index), `a${i}`));
    nodes.push(
      <Citation
        key={`c${i++}`}
        collection={m[1].trim()}
        source_video={m[2].trim()}
        source_timestamp={m[3].trim()}
        onOpen={onOpen}
      />
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(...inlineCode(text.slice(last), "aend"));
  return nodes;
}
