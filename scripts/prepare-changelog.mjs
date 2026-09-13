#!/usr/bin/env node
// Release preparation: aggregates merged-PR bilingual release notes into
// CHANGELOG.md — once per release, never per PR.
//
//   node scripts/prepare-changelog.mjs --version v0.8.0 [--date YYYY-MM-DD]
//     [--changelog PATH] [--base main] [--prs-file FIXTURES.json] [--dry-run] [--since YYYY-MM-DD]
//
// Boundary (primary): the previous version tag. The PRs in scope are those
// represented by commits in the paginated GitHub compare PREV_TAG...BASE
// (exactly that DAG range — never timestamps, never whole-history ordering),
// each mapped to its pull requests via GitHub's associated-PRs API, so normal
// merges, squash merges, and rebases all work.
// PR bodies are the source of truth for notes. Any API failure aborts instead
// of producing a partial changelog.
// Date-based GitHub search is only a fallback when no previous tag exists
// (then --since is required).
//
// Grouping is deterministic: only the PR snippet's explicit
// `Category: New|Improvement|Fix` decides the group. Snippets without a
// category go to "Uncategorized / بدون دسته‌بندی" for a human to sort.
// The prose is never reinterpreted. The result MUST be reviewed and merged
// before tagging. Re-running is safe (no duplicate entries).
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeIntoChangelog, parseReleaseNotes, selectCompareCommits, selectPrsInRange } from "./release-notes.mjs";

const TAG_RE = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function usage() {
  console.log(
    "Usage: prepare-changelog.mjs --version vMAJOR.MINOR.PATCH [--date YYYY-MM-DD] [--changelog PATH] [--base BRANCH] [--prs-file JSON] [--assoc-file JSON] [--dry-run] [--since YYYY-MM-DD] [--allow-missing-notes]",
  );
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${name}`);
  return v;
}

function compareSemver(a, b) {
  const pa = a.map(Number);
  const pb = b.map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

function previousTag() {
  const out = git("tag --list 'v*.*.*' --sort=-v:refname");
  return out
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => TAG_RE.test(t));
}

function tagExists(tag) {
  try {
    git(`rev-parse --verify --quiet 'refs/tags/${tag}'`);
    return true;
  } catch {
    return false;
  }
}

function repoNameWithOwner() {
  return execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
    encoding: "utf8",
  }).trim();
}

function ghApi(args) {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8" });
}

// Commits in PREV_TAG..BASE — the paginated GitHub compare itself, which is
// exactly that range (never timestamps, never whole-history ordering).
// Works with normal merges, squash merges, and rebases: GitHub associates
// each commit with its pull request regardless of strategy.
//
// Retrieval is fully paginated with an explicit page loop: without paging
// parameters the comparison is limited to 250 commits, so every page is
// collected and SHAs are deduplicated. Any API failure aborts with an error
// instead of producing a partial changelog.
const COMPARE_PER_PAGE = 100;
const MAX_COMPARE_PAGES = 100; // 10k commits ceiling per release range

// One compare page: range-level status plus that page's `.commits` entries.
function fetchComparePage(repo, prevTag, base, page) {
  let raw;
  try {
    raw = ghApi([
      `repos/${repo}/compare/${prevTag}...${base}?per_page=${COMPARE_PER_PAGE}&page=${page}`,
    ]);
  } catch (err) {
    throw new Error(`compare page ${page} of ${prevTag}...${base} failed (aborting, no partial changelog): ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`compare page ${page} of ${prevTag}...${base} returned malformed JSON (aborting, no partial changelog)`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.commits)) {
    throw new Error(`compare page ${page} of ${prevTag}...${base} has no commits array (aborting, no partial changelog)`);
  }
  return data;
}

function fetchCompareRange(repo, prevTag, base) {
  const first = fetchComparePage(repo, prevTag, base, 1);
  const pages = [first.commits];
  if (first.commits.length === COMPARE_PER_PAGE) {
    for (let page = 2; page <= MAX_COMPARE_PAGES; page++) {
      const data = fetchComparePage(repo, prevTag, base, page);
      pages.push(data.commits);
      if (data.commits.length < COMPARE_PER_PAGE) break;
      if (page === MAX_COMPARE_PAGES) {
        throw new Error(`compare range exceeded ${MAX_COMPARE_PAGES * COMPARE_PER_PAGE} commits — refusing to guess; split the release range`);
      }
    }
  }
  const commits = selectCompareCommits({
    status: first.status,
    aheadBy: first.ahead_by,
    behindBy: first.behind_by,
    pages,
  });
  return { commits, status: first.status };
}

function associatedPrNumbers(repo, sha) {
  // The pulls-for-commit endpoint returns an array; --paginate walks every
  // page and applies the filter per page (one JSON array per output line).
  // Small in practice, but a popular commit must not lose PRs — and any
  // unexpected shape aborts instead of producing a partial changelog.
  const raw = ghApi([
    "--paginate",
    `repos/${repo}/commits/${sha}/pulls?per_page=100`,
    "--jq",
    "[.[].number]",
  ]);
  const nums = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let page;
    try {
      page = JSON.parse(t);
    } catch {
      throw new Error(`unexpected associated-PRs response for commit ${sha} (aborting, no partial changelog)`);
    }
    if (!Array.isArray(page)) {
      throw new Error(`unexpected associated-PRs response for commit ${sha} (aborting, no partial changelog)`);
    }
    nums.push(...page);
  }
  return [...new Set(nums.map(Number))].filter(Number.isInteger);
}

function pullDetails(repo, n) {
  const pr = JSON.parse(ghApi([`repos/${repo}/pulls/${n}`]));
  return {
    number: pr.number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    base: pr.base?.ref ?? "",
    merged: pr.merged_at != null,
  };
}

function discoverPrsByAncestry({ repo, prevTag, base }) {
  const { commits } = fetchCompareRange(repo, prevTag, base);
  if (commits.length === 0) return { prs: [], commitCount: 0 };
  const associations = {};
  for (const sha of commits) {
    associations[sha] = associatedPrNumbers(repo, sha);
  }
  const nums = [...new Set(Object.values(associations).flat())].sort((a, b) => a - b);
  const details = {};
  for (const n of nums) {
    details[String(n)] = pullDetails(repo, n);
  }
  return { prs: selectPrsInRange({ commits, associations, details, base }), commitCount: commits.length };
}

function searchMergedPrsSince({ since, base, limit = 200 }) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--search", `merged:>${since}`, "--state", "merged", "--base", base, "--limit", String(limit), "--json", "number,title,body,mergedAt,url"],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(0);
  }
  let version;
  try {
    version = flag(argv, "--version");
  } catch (err) {
    console.error(`prepare-changelog: ${err.message}`);
    process.exit(1);
  }
  if (!version) {
    usage();
    process.exit(2);
  }
  version = version.trim();
  const m = TAG_RE.exec(version);
  if (!m) {
    console.error(`prepare-changelog: --version must match ^vMAJOR.MINOR.PATCH (got ${JSON.stringify(version)})`);
    process.exit(1);
  }

  const dryRun = argv.includes("--dry-run");
  const allowMissing = argv.includes("--allow-missing-notes");
  const base = flag(argv, "--base") ?? "main";
  const prsFile = flag(argv, "--prs-file");
  const assocFile = flag(argv, "--assoc-file");
  const changelogPath = resolve(process.cwd(), flag(argv, "--changelog") ?? "CHANGELOG.md");
  let date = flag(argv, "--date") ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(date)) {
    console.error(`prepare-changelog: --date must be YYYY-MM-DD (got ${JSON.stringify(date)})`);
    process.exit(1);
  }

  if (tagExists(version)) {
    console.error(`prepare-changelog: tag ${version} already exists — refusing to re-prepare a released version.`);
    process.exit(1);
  }

  let prs;
  let boundaryDesc;
  if (prsFile) {
    prs = JSON.parse(readFileSync(resolve(process.cwd(), prsFile), "utf8"));
    boundaryDesc = `--prs-file ${prsFile} (${prs.length} PRs)`;
  } else if (assocFile) {
    // Offline/deterministic seam for tests. Either a direct commit list:
    //   { commits, associations, details }
    // or raw paginated compare results (exercises the production range
    // selection, including status checks, cross-page dedupe, and aborts):
    //   { compareStatus: { status, aheadBy, behindBy }, comparePages, associations, details }
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), assocFile), "utf8"));
    let commits;
    try {
      commits = fixture.comparePages
        ? selectCompareCommits({ ...(fixture.compareStatus ?? {}), pages: fixture.comparePages })
        : (fixture.commits ?? []);
    } catch (err) {
      console.error(`prepare-changelog: ${err.message}`);
      process.exit(1);
    }
    prs = selectPrsInRange({ commits, associations: fixture.associations ?? {}, details: fixture.details ?? {}, base });
    boundaryDesc = `--assoc-file ${assocFile} (${prs.length} PRs from ${commits.length} commits by ancestry)`;
  } else {
    let tags = [];
    try {
      tags = previousTag();
    } catch {
      tags = [];
    }
    if (tags.length > 0) {
      const prev = tags[0];
      if (compareSemver([m[1], m[2], m[3]], TAG_RE.exec(prev).slice(1)) <= 0) {
        console.error(`prepare-changelog: ${version} must be newer than previous tag ${prev}.`);
        process.exit(1);
      }
      let repo;
      try {
        repo = repoNameWithOwner();
      } catch (err) {
        console.error(`prepare-changelog: failed to determine repo via gh: ${err.message}`);
        process.exit(1);
      }
      let found;
      try {
        found = discoverPrsByAncestry({ repo, prevTag: prev, base });
      } catch (err) {
        console.error(`prepare-changelog: ${err.message}`);
        process.exit(1);
      }
      prs = found.prs;
      boundaryDesc = `${prs.length} PRs from ${found.commitCount} commits in ${prev}..${base} (ancestry)`;
    } else {
      // Fallback: no previous tag — date-based search only.
      const since = flag(argv, "--since");
      if (!since || !DATE_RE.test(since)) {
        console.error(
          "prepare-changelog: no previous version tag found. Re-run with --since YYYY-MM-DD to use date-based search as a fallback.",
        );
        process.exit(1);
      }
      try {
        prs = searchMergedPrsSince({ since, base }).sort((a, b) => a.number - b.number);
      } catch (err) {
        console.error(`prepare-changelog: date-based PR search failed: ${err.message}`);
        process.exit(1);
      }
      boundaryDesc = `date-based fallback search merged:>${since} into ${base}`;
    }
  }

  const items = [];
  const skippedNone = [];
  const missing = [];
  for (const pr of prs) {
    const parsed = parseReleaseNotes(pr.body ?? "");
    if (parsed.hasNoneMarker && (!parsed.section || parsed.section.english.length + parsed.section.persian.length === 0)) {
      skippedNone.push(pr.number);
      continue;
    }
    if (!parsed.section || parsed.section.english.length === 0 || parsed.section.persian.length === 0) {
      missing.push(pr.number);
      continue;
    }
    if (parsed.section.categoryRaw !== null && parsed.section.category === null) {
      missing.push(pr.number);
      continue;
    }
    items.push({
      group: parsed.section.category ?? "Uncategorized",
      en: parsed.section.english,
      fa: parsed.section.persian,
      pr: pr.number,
    });
  }

  let changelogText;
  try {
    changelogText = readFileSync(changelogPath, "utf8");
  } catch (err) {
    console.error(`prepare-changelog: cannot read ${changelogPath}: ${err.message}`);
    process.exit(1);
  }

  const { text, added } = mergeIntoChangelog(changelogText, { version, date, items });

  if (dryRun) {
    console.log(`prepare-changelog: DRY RUN for ${version} (${boundaryDesc})`);
    console.log(`included PRs: ${items.map((i) => `#${i.pr}`).join(", ") || "(none)"}`);
    console.log(`skipped (Release notes: none): ${skippedNone.join(", ") || "(none)"}`);
    console.log(`needs notes: ${missing.map((n) => `#${n}`).join(", ") || "(none)"}`);
    console.log(`bullets that would be added: ${added}`);
    process.exit(0);
  }

  if (missing.length > 0 && !allowMissing) {
    console.error(
      `prepare-changelog: refusing to write — ${missing.length} in-range PR(s) without usable notes: ${missing.map((n) => `#${n}`).join(", ")}`,
    );
    console.error(
      "prepare-changelog: add bilingual notes (or explicit `Release notes: none`) to those PR bodies and re-run. " +
        "Only as a one-time migration escape hatch, re-run with --allow-missing-notes to omit them explicitly.",
    );
    process.exit(1);
  }

  writeFileSync(changelogPath, text);
  console.log(`prepare-changelog: ${version} <- ${boundaryDesc}`);
  console.log(`  PRs included (${items.length}): ${items.map((i) => `#${i.pr} [${i.group}]`).join(", ") || "(none)"}`);
  console.log(`  skipped internal-only (${skippedNone.length}): ${skippedNone.map((n) => `#${n}`).join(", ") || "(none)"}`);
  if (missing.length > 0) {
    console.log(`  OMITTED via --allow-missing-notes (${missing.length}): ${missing.map((n) => `#${n}`).join(", ")} — backfill their notes before the next release`);
  }
  console.log(`  bullets added: ${added} (re-runs add nothing new)`);
  console.log("  REVIEW the CHANGELOG.md diff, merge it to main, THEN tag.");
}

main();
