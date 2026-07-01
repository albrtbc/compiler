import { defineConfig } from "vitest/config";

// Pure-logic tests run in Node (no DOM needed). Modules that touch the DOM,
// canvas or IndexedDB are intentionally kept out of these unit tests — the
// pure math/codec/model modules are what carry the safety net.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    globals: false,
  },
});
