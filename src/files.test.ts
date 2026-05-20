import { describe, expect, it, vi } from "vitest";

// files.ts imports @tauri-apps plugins at module load. Stub them so the pure
// helpers (basename) can be exercised in plain node.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }));

import { basename } from "./files";

describe("basename", () => {
  it("returns the last segment of a posix path", () => {
    expect(basename("/Users/me/docs/note.md")).toBe("note.md");
    expect(basename("/note.md")).toBe("note.md");
  });

  it("returns the last segment of a windows path", () => {
    expect(basename("C:\\Users\\me\\docs\\note.md")).toBe("note.md");
    expect(basename("C:\\note.md")).toBe("note.md");
  });

  it("handles mixed separators", () => {
    expect(basename("C:/Users\\me/note.md")).toBe("note.md");
  });

  it("falls back to the whole string when there is no slash", () => {
    expect(basename("note.md")).toBe("note.md");
    expect(basename("Untitled")).toBe("Untitled");
  });

  it("falls back to the original path for a trailing-slash path", () => {
    // split(...).pop() yields "" for a trailing slash, so the `|| path` branch
    // returns the original string rather than an empty name.
    expect(basename("/Users/me/docs/")).toBe("/Users/me/docs/");
    expect(basename("C:\\Users\\me\\")).toBe("C:\\Users\\me\\");
  });

  it("falls back to the original (empty) string for an empty path", () => {
    expect(basename("")).toBe("");
  });
});
