/* =====================================================================
   engine-worker.js — Stockfish inside a Web Worker (Phase 1)
   =====================================================================
   HOW THIS WORKS (verified against stockfish.js 10.0.0, niklasf build):
   - The stockfish.js script is a self-contained asm.js build. It contains
     no WebAssembly references, so it needs no extra local files.
   - On load it installs its OWN onmessage handler on this worker and
     speaks raw UCI: strings in, engine lines out via postMessage.
   - Therefore this file deliberately defines NO onmessage of its own.
     Anything placed after importScripts that overwrote onmessage would
     break the engine. app.js (EngineBridge) speaks UCI through this
     worker's channel and parses the replies there.
   - Messages sent before the engine runtime finishes initializing are
     queued by the engine itself and flushed once it is ready, so
     EngineBridge can send "uci" immediately.

   UPGRADE PATH (wasm build):
   - The wasm variant (stockfish.wasm.js + stockfish.wasm) is faster, but
     its loader resolves the .wasm file relative to THIS worker's URL,
     so it cannot be importScripts'd from a CDN and find its .wasm file.
     To switch: vendor stockfish.wasm.js + stockfish.wasm next to this
     file and importScripts the local stockfish.wasm.js instead.
   ===================================================================== */

importScripts('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.0/stockfish.js');

// Nothing else belongs here. See the header comment.
