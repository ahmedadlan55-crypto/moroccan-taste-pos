import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver, which recharts' ResponsiveContainer requires.
// A no-op polyfill lets chart components mount in the test environment.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  // @ts-expect-error — assigning the stub onto the global
  globalThis.ResizeObserver = ResizeObserverStub;
}
