import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import {
  useUrlFilters,
  makeCodec,
  stringParam,
  boolParam,
  csvParam,
  dateParam,
} from "@/shared/hooks/useUrlFilters";

const codec = makeCodec({
  q: stringParam(),
  cats: csvParam(),
  from: dateParam(),
  active: boolParam(),
});

function Harness() {
  const { filters, patch, reset, href } = useUrlFilters(codec);
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  return (
    <div>
      <div data-testid="search">{location.search}</div>
      <div data-testid="navtype">{navType}</div>
      <div data-testid="q">{filters.q}</div>
      <div data-testid="cats">{filters.cats.join("|")}</div>
      <div data-testid="from">{filters.from}</div>
      <div data-testid="active">{String(filters.active)}</div>
      <div data-testid="href">{href({ q: "deep" })}</div>
      <button onClick={() => patch({ q: "beta" })}>patch-replace</button>
      <button onClick={() => patch({ q: "gamma" }, { push: true })}>patch-push</button>
      <button onClick={() => patch({ cats: ["a", "b"], active: true })}>patch-multi</button>
      <button onClick={() => reset()}>reset</button>
      <button onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Harness />
    </MemoryRouter>,
  );
}

describe("useUrlFilters", () => {
  it("parses typed filters from the URL (roundtrip of every param kind)", () => {
    renderAt("/hub?doc=42&q=alpha&cats=x,y&from=2026-07-01&active=1");
    expect(screen.getByTestId("q").textContent).toBe("alpha");
    expect(screen.getByTestId("cats").textContent).toBe("x|y");
    expect(screen.getByTestId("from").textContent).toBe("2026-07-01");
    expect(screen.getByTestId("active").textContent).toBe("true");
  });

  it("falls back to defaults for missing/malformed params", () => {
    renderAt("/hub?from=not-a-date");
    expect(screen.getByTestId("q").textContent).toBe("");
    expect(screen.getByTestId("cats").textContent).toBe("");
    expect(screen.getByTestId("from").textContent).toBe("");
    expect(screen.getByTestId("active").textContent).toBe("false");
  });

  it("patch() only touches codec-owned keys — foreign params survive", () => {
    renderAt("/hub?doc=42&q=alpha");
    fireEvent.click(screen.getByText("patch-multi"));
    const search = screen.getByTestId("search").textContent ?? "";
    expect(search).toContain("doc=42");
    expect(search).toContain("q=alpha");
    expect(search).toContain("active=1");
    expect(search).toMatch(/cats=a(%2C|,)b/);
  });

  it("patch() replaces history by default and pushes with { push: true }", () => {
    renderAt("/hub?q=alpha");
    fireEvent.click(screen.getByText("patch-replace"));
    expect(screen.getByTestId("q").textContent).toBe("beta");
    expect(screen.getByTestId("navtype").textContent).toBe("REPLACE");

    fireEvent.click(screen.getByText("patch-push"));
    expect(screen.getByTestId("q").textContent).toBe("gamma");
    expect(screen.getByTestId("navtype").textContent).toBe("PUSH");

    // Back pops the pushed entry and lands on the REPLACED state (beta, not alpha).
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("q").textContent).toBe("beta");
  });

  it("reset() clears every codec-owned key but keeps foreign params", () => {
    renderAt("/hub?doc=42&q=alpha&cats=x,y&active=1");
    fireEvent.click(screen.getByText("reset"));
    const search = screen.getByTestId("search").textContent ?? "";
    expect(search).toContain("doc=42");
    expect(search).not.toContain("q=");
    expect(search).not.toContain("cats=");
    expect(search).not.toContain("active=");
    expect(screen.getByTestId("q").textContent).toBe("");
  });

  it("href() renders a pathname?query deep link without navigating", () => {
    renderAt("/hub?doc=42&q=alpha");
    const href = screen.getByTestId("href").textContent ?? "";
    expect(href.startsWith("/hub?")).toBe(true);
    expect(href).toContain("doc=42");
    expect(href).toContain("q=deep");
    // rendering the href did NOT change the live URL
    expect(screen.getByTestId("q").textContent).toBe("alpha");
  });
});

describe("param codecs", () => {
  it("stringParam serializes the default/empty to null", () => {
    const p = stringParam();
    expect(p.parse(null)).toBe("");
    expect(p.parse("x")).toBe("x");
    expect(p.serialize("")).toBeNull();
    expect(p.serialize("x")).toBe("x");
  });

  it("boolParam parses 1/true/0/false and serializes the default to null", () => {
    const p = boolParam(false);
    expect(p.parse("1")).toBe(true);
    expect(p.parse("true")).toBe(true);
    expect(p.parse("0")).toBe(false);
    expect(p.parse("junk")).toBe(false);
    expect(p.serialize(false)).toBeNull();
    expect(p.serialize(true)).toBe("1");
  });

  it("csvParam splits/joins and drops empty segments", () => {
    const p = csvParam();
    expect(p.parse("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(p.parse(null)).toEqual([]);
    expect(p.serialize([])).toBeNull();
    expect(p.serialize(["a", "b"])).toBe("a,b");
  });

  it("csvParam with a non-empty default keeps an explicit empty selection representable", () => {
    const p = csvParam(["a"]);
    expect(p.parse(null)).toEqual(["a"]);
    expect(p.serialize(["a"])).toBeNull(); // default → removed
    expect(p.serialize([])).toBe(""); // cleared → key present but empty
    expect(p.parse("")).toEqual([]); // and parses back as cleared
  });

  it("dateParam accepts only YYYY-MM-DD", () => {
    const p = dateParam();
    expect(p.parse("2026-07-24")).toBe("2026-07-24");
    expect(p.parse("24/07/2026")).toBe("");
    expect(p.serialize("2026-07-24")).toBe("2026-07-24");
    expect(p.serialize("nonsense")).toBeNull();
  });
});
