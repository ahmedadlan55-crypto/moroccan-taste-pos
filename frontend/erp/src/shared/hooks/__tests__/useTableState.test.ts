import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTableState } from "@/shared/hooks";

describe("useTableState", () => {
  it("cycles sort direction asc → desc → off", () => {
    const { result } = renderHook(() => useTableState());
    expect(result.current.sort).toBeNull();
    act(() => result.current.toggleSort("name"));
    expect(result.current.sort).toEqual({ columnId: "name", dir: "asc" });
    act(() => result.current.toggleSort("name"));
    expect(result.current.sort).toEqual({ columnId: "name", dir: "desc" });
    act(() => result.current.toggleSort("name"));
    expect(result.current.sort).toBeNull();
  });

  it("resets to page 1 on a new search", () => {
    const { result } = renderHook(() => useTableState({ initialPageSize: 10 }));
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);
    act(() => result.current.setSearch("خالد"));
    expect(result.current.page).toBe(1);
    expect(result.current.search).toBe("خالد");
  });

  it("toggles column visibility", () => {
    const { result } = renderHook(() => useTableState());
    expect(result.current.hiddenColumns).toEqual([]);
    act(() => result.current.toggleColumn("amount"));
    expect(result.current.hiddenColumns).toEqual(["amount"]);
    act(() => result.current.toggleColumn("amount"));
    expect(result.current.hiddenColumns).toEqual([]);
  });
});
