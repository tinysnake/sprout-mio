import { describe, expect, it } from "vite-plus/test";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  parseTheme,
  parseThemePreference,
  readStoredPreference,
  resolveTheme,
} from "../src/lib/theme";

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
  it("只承认 system、浅色与暗色三个值", () => {
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("Dark")).toBeNull();
    expect(parseThemePreference("")).toBeNull();
    expect(parseThemePreference(undefined)).toBeNull();
    expect(parseTheme("system")).toBeNull();
  });

  it("存储缺失、损坏或不可读时退回跟随系统，而不是留在未知主题", () => {
    const storage = (value: string | null) => ({ getItem: () => value });
    expect(readStoredPreference(storage("system"))).toBe("system");
    expect(readStoredPreference(storage("dark"))).toBe("dark");
    expect(readStoredPreference(storage("light"))).toBe("light");
    expect(readStoredPreference(storage("sepia"))).toBe("system");
    expect(readStoredPreference(storage(null))).toBe("system");
    expect(readStoredPreference(null)).toBe("system");
    expect(
      readStoredPreference({
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).toBe("system");
  });

  it("按存储键读取", () => {
    const read: string[] = [];
    const storage = {
      getItem: (key: string) => {
        read.push(key);
        return "dark";
      },
    };
    expect(readStoredPreference(storage)).toBe("dark");
    expect(read).toEqual([THEME_STORAGE_KEY]);
  });

  it("跟随系统时取系统结果，显式偏好不被系统覆盖", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("切换两种主题时 classList 与结果一致", () => {
    const root = { classList: new FakeClassList() };
    expect(applyTheme("dark", root)).toBe("dark");
    expect(root.classList.values.has("dark")).toBe(true);
    expect(applyTheme("light", root)).toBe("light");
    expect(root.classList.values.has("dark")).toBe(false);
  });
});
