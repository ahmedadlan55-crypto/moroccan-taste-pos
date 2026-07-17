/**
 * ItemImageEditor — the downscale math and the capability gate.
 *
 * The math is what protects the 300KB server cap (routes/menu.js): every
 * canvas the editor draws is fitWithin(w, h, 512), so the LONGEST side can
 * never exceed 512px and aspect ratio survives. Tested pure — no canvas
 * needed, which keeps it jsdom-safe. The component itself is gated behind
 * menu.catalog.manage via usePermissions/useCan: without the capability it
 * renders NOTHING (not a disabled husk).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ItemImageEditor,
  fitWithin,
  dataUrlDecodedBytes,
  IMAGE_MAX_SIDE,
  IMAGE_MAX_DECODED_BYTES,
} from "../ItemImageEditor";

// Controllable capability gate — the component imports useCan from the shared
// permissions surface.
const canManage = vi.fn((_cap: string) => true);
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => canManage(cap),
}));

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("fitWithin — the ≤512px canvas guarantee", () => {
  it("downscales a landscape image by the LONGEST side", () => {
    expect(fitWithin(1024, 768)).toEqual({ width: 512, height: 384 });
  });

  it("downscales a portrait image by the LONGEST side", () => {
    expect(fitWithin(768, 1024)).toEqual({ width: 384, height: 512 });
  });

  it("never upscales a small image", () => {
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(512, 512)).toEqual({ width: 512, height: 512 });
  });

  it("an extreme aspect ratio still yields ≥1px on the short side", () => {
    expect(fitWithin(5000, 10)).toEqual({ width: 512, height: 1 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it("EVERY output fits inside the cap — property check across shapes", () => {
    for (const [w, h] of [[4032, 3024], [3024, 4032], [513, 512], [10000, 10000], [640, 480], [1, 9999]] as const) {
      const out = fitWithin(w, h);
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(IMAGE_MAX_SIDE);
      expect(Math.min(out.width, out.height)).toBeGreaterThanOrEqual(1);
      // aspect preserved within rounding (skip degenerate 1px results)
      if (out.height > 1 && h > 1) {
        expect(Math.abs(out.width / out.height - w / h)).toBeLessThan(0.05);
      }
    }
  });
});

describe("dataUrlDecodedBytes — mirrors the server's 300KB math", () => {
  it("computes exact decoded size from base64 length + padding", () => {
    // btoa("hello") = "aGVsbG8=" (1 pad char) → 5 bytes
    expect(dataUrlDecodedBytes("data:image/jpeg;base64,aGVsbG8=")).toBe(5);
    // btoa("hi") = "aGk=" ... 2 bytes; btoa("hey!") = "aGV5IQ==" → 4? "aGV5IQ==" decodes "hey!" (4 bytes)
    expect(dataUrlDecodedBytes("data:image/jpeg;base64,aGV5IQ==")).toBe(4);
  });

  it("the shared cap constant matches routes/menu.js (300KB)", () => {
    expect(IMAGE_MAX_DECODED_BYTES).toBe(300 * 1024);
  });
});

describe("ItemImageEditor — capability gate + remove semantics", () => {
  beforeEach(() => canManage.mockReturnValue(true));

  it("renders NOTHING without menu.catalog.manage", () => {
    canManage.mockReturnValue(false);
    const { container } = render(<ItemImageEditor current={TINY_PNG} pending={undefined} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(canManage).toHaveBeenCalledWith("menu.catalog.manage");
  });

  it("previews the stored image and offers «إزالة الصورة»", () => {
    render(<ItemImageEditor current={TINY_PNG} pending={undefined} onChange={() => {}} />);
    expect(screen.getByTestId("item-image-preview")).toHaveAttribute("src", TINY_PNG);
    expect(screen.getByText("إزالة الصورة")).toBeInTheDocument();
  });

  it("removing a STORED image emits '' (clear on save)", () => {
    const onChange = vi.fn();
    render(<ItemImageEditor current={TINY_PNG} pending={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByText("إزالة الصورة"));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("removing a merely-PENDING pick reverts to untouched (undefined)", () => {
    const onChange = vi.fn();
    render(<ItemImageEditor current={null} pending={TINY_PNG} onChange={onChange} />);
    fireEvent.click(screen.getByText("إزالة الصورة"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("without any image there is no preview and no remove button", () => {
    render(<ItemImageEditor current={null} pending={undefined} onChange={() => {}} />);
    expect(screen.queryByTestId("item-image-preview")).not.toBeInTheDocument();
    expect(screen.queryByText("إزالة الصورة")).not.toBeInTheDocument();
    expect(screen.getByText("إضافة صورة")).toBeInTheDocument();
  });

  it("a pending '' hides the preview even while a stored image exists", () => {
    render(<ItemImageEditor current={TINY_PNG} pending="" onChange={() => {}} />);
    expect(screen.queryByTestId("item-image-preview")).not.toBeInTheDocument();
  });
});
