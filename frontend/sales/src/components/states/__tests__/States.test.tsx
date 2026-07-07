import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorState } from "../States";
import { ApiError } from "@/lib/api-error";

function mk(kind: ApiError["kind"], status: number) {
  return new ApiError({ kind, status, message: "msg" });
}

describe("ErrorState routes by ApiError kind", () => {
  it("network → offline state", () => {
    render(<ErrorState error={mk("network", 0)} />);
    expect(screen.getByText(/غير متصل/)).toBeInTheDocument();
  });
  it("401 unauthorized → session expired", () => {
    render(<ErrorState error={mk("unauthorized", 401)} />);
    expect(screen.getByText(/انتهت الجلسة/)).toBeInTheDocument();
  });
  it("403 forbidden → permission denied", () => {
    render(<ErrorState error={mk("forbidden", 403)} />);
    expect(screen.getByText(/لا تملك صلاحية/)).toBeInTheDocument();
  });
  it("409 conflict → refresh CTA", () => {
    render(<ErrorState error={mk("conflict", 409)} />);
    expect(screen.getByText(/تغيّرت البيانات/)).toBeInTheDocument();
  });
  it("500 server → generic error with retry", () => {
    render(<ErrorState error={mk("server", 500)} />);
    expect(screen.getByText(/تعذّر تحميل البيانات/)).toBeInTheDocument();
  });
});
