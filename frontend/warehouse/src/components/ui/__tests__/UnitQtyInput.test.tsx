import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnitQtyInput, baseFromValue, type ItemUnitLite } from "../UnitQtyInput";

const UNITS: ItemUnitLite[] = [
  { code: "PCS", name: "حبة", factor: 1, isBase: true },
  { code: "CTN", name: "كرتون", factor: 12 },
];

describe("baseFromValue (pure)", () => {
  it("single unit: qty × factor", () => {
    expect(baseFromValue(UNITS, { unitCode: "CTN", qty: 3 }, "single")).toBe(36);
    expect(baseFromValue(UNITS, { unitCode: "PCS", qty: 5 }, "single")).toBe(5);
  });
  it("composite: major × factor + minor", () => {
    expect(baseFromValue(UNITS, { unitCode: "CTN", qty: 0, majorQty: 2, minorQty: 3 }, "composite")).toBe(27);
    expect(baseFromValue(UNITS, { unitCode: "CTN", qty: 0, majorQty: 10, minorQty: 5 }, "composite")).toBe(125);
  });
  it("unknown unit falls back to base (factor 1)", () => {
    expect(baseFromValue(UNITS, { unitCode: "ZZZ", qty: 7 }, "single")).toBe(7);
  });
});

describe("UnitQtyInput single mode", () => {
  it("shows the live base conversion when a major unit is chosen", () => {
    const onChange = vi.fn();
    render(<UnitQtyInput units={UNITS} value={{ unitCode: "CTN", qty: 3 }} onChange={onChange} mode="single" />);
    // 3 cartons × 12 = 36 حبة — English digits
    expect(screen.getByText(/36/)).toBeInTheDocument();
    expect(screen.getAllByText(/حبة/).length).toBeGreaterThan(0);
  });
  it("emits a unit change from the unit select", () => {
    const onChange = vi.fn();
    render(<UnitQtyInput units={UNITS} value={{ unitCode: "PCS", qty: 1 }} onChange={onChange} mode="single" />);
    fireEvent.change(screen.getByLabelText("الوحدة"), { target: { value: "CTN" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ unitCode: "CTN" }));
  });
  it("renders English digits only (no Arabic-Indic numerals)", () => {
    render(<UnitQtyInput units={UNITS} value={{ unitCode: "CTN", qty: 10 }} onChange={() => {}} mode="single" />);
    const conv = screen.getByText(/=/).textContent || "";
    expect(conv).not.toMatch(/[٠-٩]/); // ٠-٩ banned
    expect(conv).toMatch(/120/);
  });
});

describe("UnitQtyInput composite mode", () => {
  it("shows 2 كرتون + 3 حبة = 27 حبة", () => {
    render(<UnitQtyInput units={UNITS} value={{ unitCode: "CTN", qty: 0, majorQty: 2, minorQty: 3 }} onChange={() => {}} mode="composite" />);
    expect(screen.getByText(/27/)).toBeInTheDocument();
  });
  it("emits majorQty edits", () => {
    const onChange = vi.fn();
    render(<UnitQtyInput units={UNITS} value={{ unitCode: "CTN", qty: 0, majorQty: 0, minorQty: 0 }} onChange={onChange} mode="composite" />);
    fireEvent.change(screen.getByLabelText(/عدد كرتون/), { target: { value: "4" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ majorQty: 4 }));
  });
});
