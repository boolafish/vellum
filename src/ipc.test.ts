import { describe, expect, it } from "vitest";
import { Action, isAction } from "./ipc";

describe("isAction", () => {
  it("accepts every valid Action id (including zoom ids)", () => {
    for (const id of Object.values(Action)) {
      expect(isAction(id)).toBe(true);
    }
    // Spot-check the zoom ids explicitly per the contract.
    expect(isAction("zoom-in")).toBe(true);
    expect(isAction("zoom-out")).toBe(true);
    expect(isAction("zoom-reset")).toBe(true);
  });

  it("accepts the custom quit action (routes through the dirty guard)", () => {
    expect(isAction("quit")).toBe(true);
  });

  it("rejects predefined native menu ids that never reach the dispatcher", () => {
    // These are handled natively by WKWebView and must not be treated as
    // custom Actions if they ever leaked through the event.
    for (const id of ["copy", "undo", "redo", "cut", "paste", "select-all"]) {
      expect(isAction(id)).toBe(false);
    }
  });

  it("rejects junk and non-string values", () => {
    for (const v of ["", "nope", "NEW", "save ", " save", "find-and-replace"]) {
      expect(isAction(v)).toBe(false);
    }
    for (const v of [null, undefined, 0, 1, {}, [], true, Symbol("save")]) {
      expect(isAction(v)).toBe(false);
    }
  });
});
