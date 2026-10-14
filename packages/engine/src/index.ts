export { BuiltinEngine, createBuiltinEngine } from './engine.js';
export { Searcher } from './search.js';
export type { SearchOutcome, SearchParams, SearchStats, SearcherOptions } from './search.js';
export { MATE_SCORE, captureScore, evaluate, PIECE_SCORE, PIECE_VALUE } from './evaluate.js';
export {
  BOOK_LINES,
  BOOK_MAX_PLIES,
  bookMoveCount,
  bookPositionCount,
  buildBookTable,
  positionKey,
  probeBook,
  probeBookAtFen,
} from './book.js';
export type { BookLine, BookMove } from './book.js';
export {
  acquireWasmPosition,
  initEngineWasm,
  isWasmCoreLoaded,
  isWasmNnueReady,
  releaseWasmPosition,
  uploadNnueWeights,
  wasmPoolStats,
} from './wasmCore.js';
export { loadNnueWeights, nnueReady } from './nnue.js';
