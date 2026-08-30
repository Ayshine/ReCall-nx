// Sources on the board are courses a distiller pipeline has turned into notes.
// `hasData` ones have a collection in the vector DB you can review + be quizzed
// on. As more people distill courses, they show up in AVAILABLE_SOURCES and can
// be added to the board; until their notes finish ingesting they read as
// "distilling…" with 0 concepts.

export const SOURCES = [
  { id: "cpp", label: "C++", hours: 160, author: "you", hasData: true },
  { id: "c", label: "C", hours: 160, author: "you", hasData: true },
  {
    id: "AWS-Certified-ML-Engineer-Associate",
    label: "AWS ML",
    hours: 5.5, // slide deck: measured read-through, not a lecture runtime
    author: "you",
    hasData: true,
  },
];

// Courses others distilled — addable to your board.
export const AVAILABLE_SOURCES = [
  { id: "rust", label: "Rust", hours: 120, author: "maria.k", hasData: false },
  { id: "python", label: "Python", hours: 90, author: "devon", hasData: false },
  { id: "go", label: "Go", hours: 60, author: "aylin", hasData: false },
];
