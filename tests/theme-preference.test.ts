import { describe, expect, it } from "vite-plus/test";
import { THEME_STORAGE_KEY, applyTheme, parseTheme, readStoredTheme } from "../src/lib/theme";

class FakeClassList {
  readonly values = new Set<string>();
  toggle(name: string, force?: boolean) {
    const next = force ?? !this.values.has(name);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

describe("主题偏好", () => {
  it("只承认浅色与暗色两个值", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("Dark")).toBeNull();
    expect(parseTheme("")).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
  });

  it("存储缺失、损坏或不可读时退回浅色，而不是留在未知主题", () => {
    const storage = (value: string | null) => ({ getItem: () => value });
    expect(readStoredTheme(storage("dark"))).toBe("dark");
    expect(readStoredTheme(storage("light"))).toBe("light");
    expect(readStoredTheme(storage("sepia"))).toBe("light");
    expect(readStoredTheme(storage(null))).toBe("light");
    expect(readStoredTheme(null)).toBe("light");
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).toBe("light");
  });

  it("按存储键读取，切换两种主题时 classList 与结果一致", () => {
    const read: string[] = [];
    const storage = {
      getItem: (key: string) => {
        read.push(key);
        return "dark";
      },
    };
    expect(readStoredTheme(storage)).toBe("dark");
    expect(read).toEqual([THEME_STORAGE_KEY]);

    const root = { classList: new FakeClassList() };
    expect(applyTheme("dark", root)).toBe("dark");
    expect(root.classList.values.has("dark")).toBe(true);
    expect(applyTheme("light", root)).toBe("light");
    expect(root.classList.values.has("dark")).toBe(false);
  });
});
