import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver, which recharts' ResponsiveContainer requires.
// A no-op polyfill lets chart components mount in the test environment.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  // Cast (not @ts-expect-error) so it's correct regardless of whether the
  // installed DOM/@types already declare a compatible ResizeObserver type.
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
