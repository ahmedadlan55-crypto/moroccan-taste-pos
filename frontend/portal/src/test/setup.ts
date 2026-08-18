import "@testing-library/jest-dom/vitest";

// jsdom implements neither of these, and both sit on the portal's boot path:
//   • matchMedia — isStandalone() calls it on every render of the install banner.
//   • geolocation — the clock screen's whole flow depends on it, and tests
//     replace this stub per case (granted / denied / timed out).
// Without them the app throws before the first assertion, which reads as a test
// failure in the component rather than a missing environment.
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

if (typeof navigator !== "undefined" && !("geolocation" in navigator)) {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: () => {},
      watchPosition: () => 0,
      clearWatch: () => {},
    },
  });
}
