import { describe, expect, it, vi } from "vitest";
import { installPreloadRecovery } from "./preload-recovery";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("installPreloadRecovery", () => {
  it("prevents the chunk error and reloads only once inside the cooldown", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    let clock = 10_000;
    const dispose = installPreloadRecovery({
      target,
      storage: memoryStorage(),
      reload,
      now: () => clock,
      cooldownMs: 30_000,
    });

    const first = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);

    clock += 30_001;
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(2);

    dispose();
    clock += 30_001;
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("still avoids duplicate reloads when browser storage is blocked", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const blockedStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    };
    installPreloadRecovery({ target, storage: blockedStorage, reload, now: () => 50_000 });

    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
