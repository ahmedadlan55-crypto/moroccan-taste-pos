import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver, and @tanstack/react-virtual observes the scroll
// element with one — without this the grid cannot mount in any test at all.
// A real ResizeObserver delivers an initial observation on observe(), and the
// virtualizer depends on that to learn its viewport height; a stub with empty
// methods would leave it at 0 and render nothing. jsdom does no layout, so the
// rect comes from whatever the test stubbed onto the element.
if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      const rect = target.getBoundingClientRect();
      this.cb([{ target, contentRect: rect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

// jsdom lacks matchMedia; a minimal stub keeps responsive hooks mountable.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
