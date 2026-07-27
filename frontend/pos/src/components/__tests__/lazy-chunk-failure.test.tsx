// A failed dialog chunk must NOT take the till down.
//
// WHY: a real production incident. A till had the register open while a deploy
// restarted the server; the cashier tapped a lazily-loaded dialog inside that
// window, /pos/assets/<chunk>.js answered 502, React.lazy rejected, and —
// because Suspense does not catch rejections — the app-level boundary replaced
// the whole register with the crash screen. A missing dialog cost the cart.
//
// Two things are pinned here:
//   1. retryImport absorbs a transient failure BEFORE React ever sees it, which
//      is what actually covers a restart window.
//   2. When every attempt fails, the failure stays local — the sell surface
//      survives — and the offered recovery is honest (a reload), because React
//      caches a rejected lazy forever and an in-place retry cannot work.
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { retryImport } from "@/lib/lazyWithRetry";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

describe("retryImport", () => {
  it("absorbs a transient chunk failure so React never sees it", async () => {
    let calls = 0;
    const mod = await retryImport(async () => {
      calls += 1;
      if (calls < 2) throw new Error("Failed to fetch dynamically imported module");
      return { ok: true };
    });
    expect(mod).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("gives up after three attempts and rejects", async () => {
    let calls = 0;
    await expect(
      retryImport(async () => {
        calls += 1;
        throw new Error("gone");
      }),
    ).rejects.toThrow("gone");
    expect(calls).toBe(3);
  });

  it("resolves without retrying when the first attempt succeeds", async () => {
    let calls = 0;
    await retryImport(async () => {
      calls += 1;
      return 1;
    });
    expect(calls).toBe(1);
  });
});

/** Mirrors App's boundary contract in isolation. */
class Boundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div role="alert">
          <p>تعذّر فتح النافذة</p>
          <button onClick={() => window.location.reload()}>إعادة تحميل الصفحة</button>
          <button onClick={this.props.onClose}>إغلاق</button>
        </div>
      );
    }
    return <Suspense fallback={<div>loading</div>}>{this.props.children}</Suspense>;
  }
}

function Host({ Lazy }: { Lazy: ComponentType }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div data-testid="sell-screen">sell screen</div>
      {open ? (
        <Boundary onClose={() => setOpen(false)}>
          <Lazy />
        </Boundary>
      ) : null}
    </>
  );
}

describe("a permanently failed chunk is contained", () => {
  it("keeps the sell screen alive instead of crashing the app", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const Lazy = lazy(async () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    render(<Host Lazy={Lazy} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByTestId("sell-screen")).toBeInTheDocument();
    err.mockRestore();
  });

  it("closing returns to the sell screen with the cart intact", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const Lazy = lazy(async () => {
      throw new Error("boom");
    });
    render(<Host Lazy={Lazy} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByText("إغلاق"));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByTestId("sell-screen")).toBeInTheDocument();
    err.mockRestore();
  });

  it("the offered recovery is a reload, because React caches a rejected lazy forever", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let imports = 0;
    const Lazy = lazy(async () => {
      imports += 1;
      throw new Error("boom");
    });
    const { rerender } = render(<Host Lazy={Lazy} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    rerender(<Host Lazy={Lazy} />);
    // Re-rendering does NOT re-invoke the factory — this is exactly why an
    // in-place "try again" button would show a spinner and fail again.
    expect(imports).toBe(1);
    expect(screen.getByText("إعادة تحميل الصفحة")).toBeInTheDocument();
    err.mockRestore();
  });
});
