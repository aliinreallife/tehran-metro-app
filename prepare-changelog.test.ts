import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PREPARE = join(process.cwd(), "scripts", "prepare-changelog.mjs");
const EXTRACT = join(process.cwd(), "scripts", "extract-changelog-section.mjs");

const BASE_CHANGELOG = `# Changelog

## [Unreleased]
`;

function fixturePrs() {
  return [
    {
      number: 101,
      title: "Add night departures",
      body: "## Release notes\nCategory: New\n### English\n- Night departures are now shown.\n### فارسی\n- حرکت‌های شبانه حالا نمایش داده می‌شوند.\n",
    },
    {
      number: 102,
      title: "Fix midnight crash",
      body: "## Release notes\nCategory: Fix\n### English\n- Fixed a crash after midnight.\n### فارسی\n- کرش بعد از نیمه‌شب رفع شد.\n",
    },
    {
      number: 103,
      title: "Faster search",
      body: "## Release notes\n### English\n- Search is faster.\n### فارسی\n- جست‌وجو سریع‌تر شد.\n",
    },
    { number: 104, title: "Bump CI action", body: "Routine bump.\n\nRelease notes: none\n" },
  ];
}

// Ancestry fixture: which PRs are in range is decided ONLY by
// commit->PR associations. mergedAt values are deliberately misleading to
// prove timestamps cannot change the result.
function assocFixture() {
  return {
    commits: ["c1", "c2", "c3", "c4"],
    associations: { c1: [101], c2: [101, 102], c3: [103], c4: [104] },
    details: {
      // Merged long ago but stamped with a fresh mergedAt: still excluded,
      // because no in-range commit is associated with it.
      90: {
        number: 90,
        title: "Old work",
        body: "## Release notes\nCategory: New\n### English\n- Old stuff.\n### فارسی\n- چیز قدیمی.\n",
        base: "main",
        merged: true,
        mergedAt: "2026-09-13T00:00:00Z",
      },
      // mergedAt older than any tag: still included (timestamps ignored).
      101: {
        number: 101,
        title: "Add night departures",
        body: "## Release notes\nCategory: New\n### English\n- Night departures are now shown.\n### فارسی\n- حرکت‌های شبانه حالا نمایش داده می‌شوند.\n",
        base: "main",
        merged: true,
        mergedAt: "2001-01-01T00:00:00Z",
      },
      102: {
        number: 102,
        title: "Fix midnight crash",
        body: "## Release notes\nCategory: Fix\n### English\n- Fixed a crash after midnight.\n### فارسی\n- کرش بعد از نیمه‌شب رفع شد.\n",
        base: "main",
        merged: true,
        mergedAt: "2026-09-13T00:00:00Z",
      },
      // Closed without merging: excluded despite an in-range association.
      103: {
        number: 103,
        title: "Abandoned idea",
        body: "## Release notes\n### English\n- Never shipped.\n### فارسی\n- هرگز منتشر نشد.\n",
        base: "main",
        merged: false,
        mergedAt: "2026-09-13T00:00:00Z",
      },
      // Merged into another branch: excluded.
      104: {
        number: 104,
        title: "Side branch work",
        body: "## Release notes\n### English\n- Elsewhere.\n### فارسی\n- جای دیگر.\n",
        base: "feature",
        merged: true,
        mergedAt: "2026-09-13T00:00:00Z",
      },
    },
  };
}

function runPrepare(dir: string, args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync("node", [PREPARE, ...args], { encoding: "utf8", cwd: dir });
    return { status: 0, out: String(out) };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
  const changelog = join(dir, "CHANGELOG.md");
  const prsFile = join(dir, "prs.json");
  writeFileSync(changelog, BASE_CHANGELOG);
  writeFileSync(prsFile, JSON.stringify(fixturePrs()));
  return { dir, changelog, prsFile };
}

describe("prepare-changelog.mjs", () => {
  it("aggregates PR snippets into groups with PR refs", () => {
    const { dir, changelog, prsFile } = setup();
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--prs-file",
      prsFile,
    ]);
    expect(r.status).toBe(0);
    const text = readFileSync(changelog, "utf8");
    expect(text).toContain("## [v0.8.0] - 2026-09-20");
    expect(text).toContain("## [Unreleased]");
    expect(text).toContain("### New / جدید");
    expect(text).toContain("### Fixes / رفع مشکلات");
    expect(text).toContain("### Uncategorized / بدون دسته‌بندی");
    expect(text).toContain("Night departures are now shown. (#101)");
    expect(text).toContain("کرش بعد از نیمه‌شب رفع شد. (#102)");
    expect(text).toContain("Search is faster. (#103)");
    expect(text).not.toContain("#104");
    expect(r.out).toMatch(/skipped internal-only \(1\): #104/);
  });

  it("selects PRs by commit ancestry, ignoring timestamps, deduped", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(assocFile, JSON.stringify(assocFixture()));
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--assoc-file",
      assocFile,
    ]);
    expect(r.status).toBe(0);
    const text = readFileSync(changelog, "utf8");
    // In range via associations (timestamps say otherwise): included.
    expect(text).toContain("Night departures are now shown. (#101)");
    expect(text).toContain("Fixed a crash after midnight. (#102)");
    // Contained in the previous tag / unmerged / other branch: excluded.
    expect(text).not.toContain("Old stuff.");
    expect(text).not.toContain("Never shipped.");
    expect(text).not.toContain("Elsewhere.");
    // Duplicate commit->PR associations (c1+c2 -> #101) yield one entry.
    const occurrences = text.split("Night departures are now shown. (#101)").length - 1;
    expect(occurrences).toBe(1);
  });

  it("blocks a real run when in-range PRs lack notes, without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const prsFile = join(dir, "prs.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      prsFile,
      JSON.stringify([...fixturePrs().slice(0, 1), { number: 105, title: "Forgot notes", body: "Oops, no section here.\n" }]),
    );
    const args = ["--version", "v0.8.0", "--date", "2026-09-20", "--changelog", changelog, "--prs-file", prsFile];
    const r = runPrepare(dir, args);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/#105/);
    expect(readFileSync(changelog, "utf8")).toBe(BASE_CHANGELOG);
  });

  it("dry-run reports missing notes but stays informational", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const prsFile = join(dir, "prs.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      prsFile,
      JSON.stringify([...fixturePrs().slice(0, 1), { number: 105, title: "Forgot notes", body: "Oops, no section here.\n" }]),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--prs-file",
      prsFile,
      "--dry-run",
    ]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/needs notes: #105/);
    expect(readFileSync(changelog, "utf8")).toBe(BASE_CHANGELOG);
  });

  it("allows an explicit opt-in escape hatch for missing notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const prsFile = join(dir, "prs.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      prsFile,
      JSON.stringify([...fixturePrs().slice(0, 1), { number: 105, title: "Forgot notes", body: "Oops, no section here.\n" }]),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--prs-file",
      prsFile,
      "--allow-missing-notes",
    ]);
    expect(r.status).toBe(0);
    const text = readFileSync(changelog, "utf8");
    expect(text).toContain("## [v0.8.0]");
    expect(text).toContain("Night departures are now shown. (#101)");
    expect(r.out).toMatch(/OMITTED via --allow-missing-notes.*#105/);
  });

  it("is idempotent: a second run adds nothing", () => {
    const { dir, changelog, prsFile } = setup();
    const args = [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--prs-file",
      prsFile,
    ];
    expect(runPrepare(dir, args).status).toBe(0);
    const first = readFileSync(changelog, "utf8");
    const second = runPrepare(dir, args);
    expect(second.status).toBe(0);
    expect(second.out).toMatch(/bullets added: 0/);
    expect(readFileSync(changelog, "utf8")).toBe(first);
  });

  it("dry-run does not write", () => {
    const { dir, changelog, prsFile } = setup();
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--prs-file",
      prsFile,
      "--dry-run",
    ]);
    expect(r.status).toBe(0);
    expect(readFileSync(changelog, "utf8")).toBe(BASE_CHANGELOG);
  });

  it("rejects a non-semver version", () => {
    const { dir, changelog, prsFile } = setup();
    const r = runPrepare(dir, ["--version", "0.8", "--changelog", changelog, "--prs-file", prsFile]);
    expect(r.status).not.toBe(0);
  });

  it("includes a PR that appears only on page 2, deduped across pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      assocFile,
      JSON.stringify({
        compareStatus: { status: "ahead", aheadBy: 3, behindBy: 0 },
        // Two compare pages; c1 is duplicated across the page boundary.
        comparePages: [[{ sha: "c1" }], [{ sha: "c2" }, { sha: "c3" }, { sha: "c1" }]],
        associations: { c1: [101], c2: [102], c3: [106] },
        details: {
          101: assocFixture().details[101],
          102: assocFixture().details[102],
          106: {
            number: 106,
            title: "Page-two feature",
            body: "## Release notes\nCategory: Improvement\n### English\n- Smoother scrolling.\n### فارسی\n- اسکرول نرم‌تر.\n",
            base: "main",
            merged: true,
          },
        },
      }),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--assoc-file",
      assocFile,
    ]);
    expect(r.status).toBe(0);
    const text = readFileSync(changelog, "utf8");
    expect(text).toContain("Smoother scrolling. (#106)");
    expect(text).toContain("### Improvements / بهبودها");
    const occurrences = text.split("Night departures are now shown. (#101)").length - 1;
    expect(occurrences).toBe(1);
  });

  it("collects full pages with no 250-commit ceiling", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    // Page 1 is exactly full (100 entries): traversal must spill onto page 2,
    // where the only PR-associated commit lives.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ sha: `f1-${String(i).padStart(3, "0")}` }));
    writeFileSync(
      assocFile,
      JSON.stringify({
        compareStatus: { status: "ahead", aheadBy: 101, behindBy: 0 },
        comparePages: [fullPage, [{ sha: "c3" }]],
        associations: { c3: [106] },
        details: {
          106: {
            number: 106,
            title: "Page-two feature",
            body: "## Release notes\nCategory: Improvement\n### English\n- Smoother scrolling.\n### فارسی\n- اسکرول نرم‌تر.\n",
            base: "main",
            merged: true,
          },
        },
      }),
    );
    const args = ["--version", "v0.8.0", "--date", "2026-09-20", "--changelog", changelog, "--assoc-file", assocFile];
    const r = runPrepare(dir, args);
    expect(r.status).toBe(0);
    const text = readFileSync(changelog, "utf8");
    expect(text).toContain("Smoother scrolling. (#106)");
    expect(r.out).toMatch(/101 commits/);
  });

  it("counts a 260-commit range completely (past the old 250 cap)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    const page = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ sha: `${prefix}-${String(i).padStart(3, "0")}` }));
    writeFileSync(
      assocFile,
      JSON.stringify({
        compareStatus: { status: "ahead", aheadBy: 260, behindBy: 0 },
        comparePages: [page("a", 100), page("b", 100), page("c", 60)],
        associations: {},
        details: {},
      }),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--assoc-file",
      assocFile,
      "--dry-run",
    ]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/260 commits/);
  });

  it("identical comparison yields zero PRs", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      assocFile,
      JSON.stringify({
        compareStatus: { status: "identical", aheadBy: 0, behindBy: 0 },
        comparePages: [[]],
        associations: {},
        details: {},
      }),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--assoc-file",
      assocFile,
      "--dry-run",
    ]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/0 PRs from 0 commits/);
  });

  it.each([
    ["diverged", { status: "diverged", aheadBy: 2, behindBy: 3 }],
    ["behind", { status: "behind", aheadBy: 0, behindBy: 2 }],
    ["unknown status", { status: "weird", aheadBy: 1, behindBy: 0 }],
    ["identical with nonzero counts", { status: "identical", aheadBy: 2, behindBy: 0 }],
    ["ahead with behind commits", { status: "ahead", aheadBy: 2, behindBy: 1 }],
    ["ahead with zero ahead count", { status: "ahead", aheadBy: 0, behindBy: 0 }],
  ])("aborts on %s instead of guessing a range", (_label, compareStatus) => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      assocFile,
      JSON.stringify({
        compareStatus,
        comparePages: [[{ sha: "c1" }]],
        associations: { c1: [101] },
        details: { 101: assocFixture().details[101] },
      }),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--assoc-file",
      assocFile,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/clean compare range|inconsistent compare result/);
    expect(readFileSync(changelog, "utf8")).toBe(BASE_CHANGELOG);
  });

  it.each([
    ["empty page list", { compareStatus: { status: "ahead", aheadBy: 1, behindBy: 0 }, comparePages: [] }],
    ["malformed first page", { compareStatus: { status: "ahead", aheadBy: 1, behindBy: 0 }, comparePages: ["nope"] }],
    ["malformed later page", { compareStatus: { status: "ahead", aheadBy: 2, behindBy: 0 }, comparePages: [[{ sha: "c1" }], "oops"] }],
  ])("aborts on %s rather than assuming an empty range", (_label, fixture) => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-changelog-"));
    const changelog = join(dir, "CHANGELOG.md");
    const assocFile = join(dir, "assoc.json");
    writeFileSync(changelog, BASE_CHANGELOG);
    writeFileSync(
      assocFile,
      JSON.stringify({
        associations: { c1: [101] },
        details: { 101: assocFixture().details[101] },
        ...fixture,
      }),
    );
    const r = runPrepare(dir, [
      "--version",
      "v0.8.0",
      "--date",
      "2026-09-20",
      "--changelog",
      changelog,
      "--assoc-file",
      assocFile,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/compare page|first compare page/);
    expect(readFileSync(changelog, "utf8")).toBe(BASE_CHANGELOG);
  });
});

describe("extract-changelog-section.mjs", () => {
  function extract(args: string[]): { status: number; out: string } {
    try {
      const out = execFileSync("node", [EXTRACT, ...args], { encoding: "utf8" });
      return { status: 0, out: String(out) };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
      return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  }

  it("extracts a real version from CHANGELOG.md", () => {
    const r = extract(["v0.7.0"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("installable Android app");
    expect(r.out).toContain("اپلیکیشن قابل‌نصب اندروید");
    expect(r.out).not.toMatch(/^## \[v0\.7\.0\]/m);
  });

  it("fails when the requested version is absent", () => {
    const r = extract(["v9.9.9"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/no "## \[v9\.9\.9\]"/);
  });
});
