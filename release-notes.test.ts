import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "check-release-notes.mjs");

function check(
  body: string,
  extraArgs: string[] = [],
): { status: number; out: string; json?: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body);
  try {
    const out = execFileSync("node", [SCRIPT, "--body-file", file, ...extraArgs], {
      encoding: "utf8",
    });
    const json = extraArgs.includes("--json") ? JSON.parse(String(out)) : undefined;
    return { status: 0, out: String(out), json };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

const VALID = `Adds night departures.

## Release notes
Category: Fix
### English
- Fixed missing last-train times after midnight.
### فارسی
- ساعت‌های حرکت قطار آخر شب بعد از نیمه‌شب اصلاح شد.
`;

describe("check-release-notes.mjs", () => {
  it("accepts a valid bilingual body with category", () => {
    const r = check(VALID, ["--json"]);
    expect(r.status).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.kind).toBe("notes");
    expect(r.json?.category).toBe("Fix");
  });

  it("accepts a body without category (uncategorized for review)", () => {
    const r = check(
      "## Release notes\n### English\n- Faster search.\n### فارسی\n- جست‌وجوی سریع‌تر.\n",
      ["--json"],
    );
    expect(r.status).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.category).toBe(null);
  });

  it("accepts Release notes: none", () => {
    const r = check("chore(ci): bump action\n\nRelease notes: none\n", ["--json"]);
    expect(r.status).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.kind).toBe("none");
  });

  it("rejects a missing section", () => {
    const r = check("Just a plain description with no notes.\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Missing bilingual release notes/);
  });

  it("rejects a missing Persian section", () => {
    const r = check("## Release notes\n### English\n- Something changed.\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/فارسی/);
  });

  it("rejects a missing English section", () => {
    const r = check("## Release notes\n### فارسی\n- چیزی تغییر کرد.\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/English/);
  });

  it("rejects empty/placeholder bullets", () => {
    const r = check("## Release notes\n### English\n- ...\n### فارسی\n- ...\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Empty/);
  });

  it("rejects an invalid category", () => {
    const r = check(
      "## Release notes\nCategory: Magic\n### English\n- Wow.\n### فارسی\n- واو.\n",
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Invalid Category/);
  });

  it("rejects none-marker combined with bullets", () => {
    const r = check(`${VALID}\nRelease notes: none\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Ambiguous/);
  });

  it("warns (but passes) on overly long notes", () => {
    const longEn = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
    const r = check(`## Release notes\n### English\n- ${longEn}\n### فارسی\n- کوتاه.\n`, [
      "--json",
    ]);
    expect(r.status).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect((r.json?.warnings as string[]).length).toBeGreaterThan(0);
  });
});
