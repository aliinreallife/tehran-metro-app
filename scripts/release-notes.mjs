#!/usr/bin/env node
// Shared bilingual (English + Persian) release-notes helpers.
//
// Single source of truth for:
//   - scripts/check-release-notes.mjs      (PR-body CI check)
//   - scripts/prepare-changelog.mjs        (release-prep aggregation)
//   - scripts/extract-changelog-section.mjs (GitHub Release body)
//
// Pure functions, Node builtins only — no dependencies, no LLM, deterministic.
//
// PR snippet contract (see AGENTS.md):
//
//   ## Release notes
//   Category: New               <- optional; New | Improvement | Fix
//   ### English
//   - ...
//   ### فارسی
//   - ...
//
// …or, for internal-only PRs, a line containing exactly:
//
//   Release notes: none

// Canonical groups in render order. "Uncategorized" is the neutral/default
// bucket for snippets without a Category — a human sorts them during review.
export const GROUP_ORDER = ["New", "Improvement", "Fix", "Uncategorized"];

export const GROUP_HEADINGS = {
  New: "### New / جدید",
  Improvement: "### Improvements / بهبودها",
  Fix: "### Fixes / رفع مشکلات",
  Uncategorized: "### Uncategorized / بدون دسته‌بندی",
};

export const FA_SUBHEADING = "#### فارسی";

// Accepted Category values (case-insensitive). A small fixed alias map —
// deterministic normalization, never prose interpretation.
const CATEGORY_ALIASES = new Map([
  ["new", "New"],
  ["improvement", "Improvement"],
  ["improvements", "Improvement"],
  ["fix", "Fix"],
  ["fixes", "Fix"],
  ["bugfix", "Fix"],
  ["bug fix", "Fix"],
]);

export const VALID_CATEGORY_LABELS = ["New", "Improvement", "Fix"];

const NONE_MARKER_RE = /^\*{0,2}\s*release notes\s*:\s*none\s*\*{0,2}\s*$/im;
const SECTION_HEADING_RE = /^#{2,3}\s*release notes\s*:?\s*$/im;
// A level-1 or level-2 markdown heading ends the release-notes section;
// deeper headings (### English, ### فارسی, #### فارسی) are part of it.
const SECTION_END_RE = /^#{1,2}(?:\s|$)/;
const ANY_HEADING_RE = /^\s*#{1,6}\s/;
const EN_HEADING_RE = /^#{2,4}\s*english\s*$/im;
const FA_HEADING_RE = /^#{2,4}\s*(?:فارسی|persian)\s*$/im;
const CATEGORY_RE = /^\*{0,2}\s*category\s*\*{0,2}\s*:\s*(.+?)\s*$/im;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
// Template scaffolding / empty bullets must not count as real content.
const PLACEHOLDER_RE = /^(?:\.\.\.|…|TODO\b.*|TBD\b.*|<[^>]*>)$/i;
const TRAILING_REF_RE = /\s*\(#\d+\)\s*$/;

export function normalizeCategory(raw) {
  if (raw == null) return null;
  return CATEGORY_ALIASES.get(String(raw).trim().toLowerCase()) ?? null;
}

function splitLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

function collectBullets(lines) {
  const bullets = [];
  for (const line of lines) {
    const m = BULLET_RE.exec(line);
    if (!m) continue;
    const item = m[1].trim();
    if (!item || PLACEHOLDER_RE.test(item)) continue;
    bullets.push(item);
  }
  return bullets;
}

function countWords(items) {
  return items.join(" ").split(/\s+/).filter(Boolean).length;
}

/**
 * Parse a PR body. Returns:
 * {
 *   hasNoneMarker: boolean,
 *   section: null | {
 *     categoryRaw: string | null, category: "New"|"Improvement"|"Fix"|null,
 *     english: string[], persian: string[],
 *   }
 * }
 */
export function parseReleaseNotes(body) {
  const text = String(body ?? "");
  const hasNoneMarker = NONE_MARKER_RE.test(text);
  const lines = splitLines(text);
  const headIdx = lines.findIndex((l) => SECTION_HEADING_RE.test(l));
  if (headIdx === -1) return { hasNoneMarker, section: null };

  // Section runs until the next level-1/2 heading (a new top-level section) or EOF.
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (SECTION_END_RE.test(lines[i].trim())) {
      endIdx = i;
      break;
    }
  }
  const slice = lines.slice(headIdx + 1, endIdx);

  let categoryRaw = null;
  for (const line of slice) {
    if (ANY_HEADING_RE.test(line)) break; // category must precede subsections
    const m = CATEGORY_RE.exec(line);
    if (m) {
      categoryRaw = m[1].trim();
      break;
    }
  }

  const enIdx = slice.findIndex((l) => EN_HEADING_RE.test(l));
  const faIdx = slice.findIndex((l) => FA_HEADING_RE.test(l));

  const bulletsAfter = (start) => {
    if (start === -1) return [];
    let end = slice.length;
    for (let i = start + 1; i < slice.length; i++) {
      if (ANY_HEADING_RE.test(slice[i])) {
        end = i;
        break;
      }
    }
    return collectBullets(slice.slice(start + 1, end));
  };

  const english = bulletsAfter(enIdx);
  const persian = bulletsAfter(faIdx);

  return {
    hasNoneMarker,
    section: {
      categoryRaw,
      category: normalizeCategory(categoryRaw),
      english,
      persian,
    },
  };
}

/**
 * Validate a PR body against the contract.
 * { ok, kind: "notes"|"none"|"missing", errors[], warnings[], parsed }
 */
export function validateReleaseNotes(body) {
  const errors = [];
  const warnings = [];
  const parsed = parseReleaseNotes(body);
  const { hasNoneMarker, section } = parsed;
  const realBullets = section ? section.english.length + section.persian.length : 0;

  if (hasNoneMarker && realBullets > 0) {
    errors.push(
      'Ambiguous PR body: it contains both "Release notes: none" and release-note bullets. Keep exactly one.',
    );
    return { ok: false, kind: "missing", errors, warnings, parsed };
  }
  if (hasNoneMarker) {
    return { ok: true, kind: "none", errors, warnings, parsed };
  }
  if (!section) {
    errors.push(
      'Missing bilingual release notes. Add a "## Release notes" section with "### English" and "### فارسی" bullets, or exactly "Release notes: none" for internal-only changes. See AGENTS.md.',
    );
    return { ok: false, kind: "missing", errors, warnings, parsed };
  }
  if (section.categoryRaw !== null && section.category === null) {
    errors.push(
      `Invalid Category ${JSON.stringify(section.categoryRaw)}. Use one of: ${VALID_CATEGORY_LABELS.join(", ")}. Omit the line if unsure — the entry goes to Uncategorized for human review.`,
    );
  }
  if (section.english.length === 0) {
    errors.push(
      'Empty "### English" release notes. Add 1–3 short plain-language bullets (placeholder "- ..." does not count).',
    );
  }
  if (section.persian.length === 0) {
    errors.push(
      'Empty "### فارسی" release notes. Add 1–3 short plain-language bullets in Persian (placeholder "- ..." does not count).',
    );
  }
  for (const [label, items] of [
    ["English", section.english],
    ["Persian", section.persian],
  ]) {
    const words = countWords(items);
    if (words > 60) {
      warnings.push(`${label} release notes are ~${words} words (keep roughly ≤ 60).`);
    }
    if (items.length > 3) {
      warnings.push(`${label} release notes have ${items.length} bullets (keep roughly 1–3).`);
    }
  }
  return {
    ok: errors.length === 0,
    kind: "notes",
    errors,
    warnings,
    parsed,
  };
}

/**
 * Select the in-range commit SHAs from paginated GitHub compare results.
 *
 * `pages` is an array of pages, each an array of compare `.commits` entries
 * (`{ sha, ... }`), newest first. Status/count validation is strict:
 *   - "identical" is valid only with ahead_by === 0 and behind_by === 0.
 *   - "ahead" is valid only with ahead_by > 0 and behind_by === 0.
 *   - "behind", "diverged", unknown statuses, or inconsistent counts throw.
 *   - A missing/malformed first page throws — never read as an empty range.
 *   - An "ahead" range that yields zero commits throws (truncated response).
 *
 * SHAs are deduplicated defensively. Throws on anything unexpected so the
 * caller aborts instead of producing a partial changelog.
 */
export function selectCompareCommits({ status, aheadBy = 0, behindBy = 0, pages = [] }) {
  const name = status === undefined || status === null ? "(missing)" : JSON.stringify(String(status));
  const ahead = Number(aheadBy);
  const behind = Number(behindBy);
  if (status === "identical") {
    if (ahead !== 0 || behind !== 0) {
      throw new Error(
        `inconsistent compare result (status identical with ahead_by=${aheadBy} behind_by=${behindBy}) — aborting, no partial changelog`,
      );
    }
    return [];
  }
  if (status !== "ahead" || !(ahead > 0) || behind !== 0) {
    throw new Error(
      `cannot determine a clean compare range (status: ${name}, ahead_by=${aheadBy}, behind_by=${behindBy}) — aborting, no partial changelog`,
    );
  }
  if (!Array.isArray(pages) || pages.length === 0 || !Array.isArray(pages[0])) {
    throw new Error("missing first compare page — aborting rather than assuming an empty range");
  }
  const seen = new Set();
  const ordered = [];
  for (const page of pages) {
    if (!Array.isArray(page)) {
      throw new Error("malformed compare page — aborting, no partial changelog");
    }
    for (const entry of page) {
      const sha = String(entry?.sha ?? "").trim();
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      ordered.push(sha);
    }
  }
  if (ordered.length === 0) {
    throw new Error("compare reports ahead commits but returned none — aborting, no partial changelog");
  }
  return ordered;
}

/**
 * Select the merged PRs represented by commits in a PREV_TAG..BASE range.
 *
 * Pure ancestry-based selection — commit/PR timestamps are never consulted:
 *   - commits: SHAs returned by the GitHub compare of PREV_TAG...BASE
 *     (i.e. commits reachable from BASE but not from PREV_TAG).
 *   - associations: map of commit SHA -> PR numbers associated with it
 *     (GitHub's commit→pulls association, merge-strategy agnostic:
 *     normal merges, squash merges, and rebases all associate).
 *   - details: map of PR number -> { number, title, body, base, merged }.
 *   - base: release branch name; only PRs merged into it are selected.
 *
 * Returns unique PR detail objects sorted by PR number.
 */
export function selectPrsInRange({ commits = [], associations = {}, details = {}, base = "main" }) {
  const seen = new Map();
  for (const sha of commits) {
    const nums = associations[sha] ?? [];
    for (const n of nums) {
      const d = details[String(n)] ?? details[n];
      if (!d) continue;
      if (d.merged !== true) continue;
      if ((d.base ?? "main") !== base) continue;
      const number = Number(d.number ?? n);
      if (!Number.isInteger(number)) continue;
      if (!seen.has(number)) seen.set(number, { ...d, number });
    }
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/** Append a "(#NN)" PR reference to a bullet unless already present. */
export function withPrRef(bullet, prNumber) {
  const text = String(bullet).trim();
  if (new RegExp(`\\(#${prNumber}\\)\\s*$`).test(text)) return text;
  return `${text} (#${prNumber})`;
}

function normalizeBulletLine(line) {
  return String(line).trim().replace(/\s+/g, " ").toLowerCase();
}

function bulletIdentity(line) {
  // Identity ignores the trailing "(#NN)" ref so re-runs and light human
  // curation do not produce duplicates.
  return normalizeBulletLine(String(line).replace(TRAILING_REF_RE, ""));
}

function versionHeading(version) {
  return `## [${version}]`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render a full version section. `groups` maps group name -> array of
 * { en: string[], fa: string[], pr: number|null }.
 */
export function renderVersionSection({ version, date, groups }) {
  const out = [`${versionHeading(version)} - ${date}`, ""];
  for (const group of GROUP_ORDER) {
    const items = (groups[group] ?? []).filter((it) => it.en.length + it.fa.length > 0);
    if (items.length === 0) continue;
    const enLines = [];
    const faLines = [];
    for (const item of items) {
      for (const b of item.en) enLines.push(`- ${item.pr ? withPrRef(b, item.pr) : b}`);
      for (const b of item.fa) faLines.push(`- ${item.pr ? withPrRef(b, item.pr) : b}`);
    }
    out.push(GROUP_HEADINGS[group], "");
    if (enLines.length > 0) out.push(...enLines, "");
    if (faLines.length > 0) out.push(FA_SUBHEADING, "", ...faLines, "");
  }
  // Trim trailing blank lines, ensure single trailing newline handled by caller.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/**
 * Extract the body of a `## [version]` section (heading line excluded).
 * Returns the trimmed body string, or null when absent.
 */
export function extractChangelogSection(changelogText, version) {
  const lines = splitLines(changelogText);
  const headRe = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`);
  const headIdx = lines.findIndex((l) => headRe.test(l));
  if (headIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(headIdx + 1, endIdx).join("\n").trim() + "\n";
}

/**
 * Merge rendered entries into CHANGELOG text (idempotent).
 * `items`: [{ group, en, fa, pr }] with raw bullet strings.
 * Returns { text, added }.
 */
export function mergeIntoChangelog(changelogText, { version, date, items }) {
  const groupOf = (item) =>
    item.group && GROUP_HEADINGS[item.group] ? item.group : "Uncategorized";

  // Desired bullet lines per group.
  const desired = new Map(GROUP_ORDER.map((g) => [g, []]));
  for (const item of items) {
    const g = groupOf(item);
    for (const b of item.en) desired.get(g).push({ line: `- ${item.pr ? withPrRef(b, item.pr) : b}`, lang: "en" });
    for (const b of item.fa) desired.get(g).push({ line: `- ${item.pr ? withPrRef(b, item.pr) : b}`, lang: "fa" });
  }

  const lines = splitLines(changelogText);
  const headRe = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`);
  let headIdx = lines.findIndex((l) => headRe.test(l));

  if (headIdx === -1) {
    // Fresh section: render whole block and insert after [Unreleased].
    const groups = {};
    for (const g of GROUP_ORDER) {
      groups[g] = [];
    }
    for (const item of items) {
      groups[groupOf(item)].push({ en: item.en, fa: item.fa, pr: item.pr });
    }
    const section = renderVersionSection({ version, date, groups });
    const unreleasedIdx = lines.findIndex((l) => /^##\s*\[Unreleased\]/i.test(l));
    let insertAt = lines.length;
    if (unreleasedIdx !== -1) {
      insertAt = lines.length;
      for (let i = unreleasedIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) {
          insertAt = i;
          break;
        }
      }
    }
    const before = lines.slice(0, insertAt).join("\n").replace(/\s+$/, "");
    const after = lines.slice(insertAt).join("\n").replace(/^\s+/, "");
    const added = [...desired.values()].reduce((n, arr) => n + arr.length, 0);
    const text = [before, "", section.trimEnd(), "", after].filter((p, i, a) => !(p === "" && a[i - 1] === "")).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return { text, added };
  }

  // Existing section: append only bullets not already present.
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const existing = new Set();
  for (let i = headIdx + 1; i < endIdx; i++) {
    const m = BULLET_RE.exec(lines[i]);
    if (m && m[1].trim()) existing.add(bulletIdentity(lines[i]));
  }

  let added = 0;
  // Work on a mutable copy of the section slice.
  const section = lines.slice(headIdx, endIdx);
  const groupHeadingLine = (g) => GROUP_HEADINGS[g];

  for (const g of GROUP_ORDER) {
    const wanted = desired.get(g).filter((d) => !existing.has(bulletIdentity(d.line)));
    if (wanted.length === 0) continue;
    const enWanted = wanted.filter((d) => d.lang === "en").map((d) => d.line);
    const faWanted = wanted.filter((d) => d.lang === "fa").map((d) => d.line);

    let gIdx = section.findIndex((l) => l.trim() === groupHeadingLine(g));
    if (gIdx === -1) {
      // Append a new group block at the end of the section.
      while (section.length > 0 && section[section.length - 1].trim() === "") section.pop();
      section.push("", groupHeadingLine(g), "");
      gIdx = section.length - 3 + 2; // index of heading line
    }
    // Group block ends at the next ### heading / ## heading or section end.
    let blockEnd = section.length;
    for (let i = gIdx + 1; i < section.length; i++) {
      if (/^\s*#{2,6}\s/.test(section[i])) {
        blockEnd = i;
        break;
      }
    }
    let faIdx = -1;
    for (let i = gIdx + 1; i < blockEnd; i++) {
      if (section[i].trim() === FA_SUBHEADING) {
        faIdx = i;
        break;
      }
    }
    if (enWanted.length > 0) {
      const at = faIdx === -1 ? blockEnd : faIdx;
      section.splice(at, 0, ...enWanted);
      // Ensure a blank line separates the inserted bullets from what follows.
      if (section[at + enWanted.length] !== undefined && section[at + enWanted.length].trim() !== "") {
        section.splice(at + enWanted.length, 0, "");
      }
      for (const l of enWanted) existing.add(bulletIdentity(l));
      added += enWanted.length;
    }
    if (faWanted.length > 0) {
      // Re-locate fermer markers after EN insertion.
      let fIdx = -1;
      let bEnd = section.length;
      for (let i = gIdx + 1; i < section.length; i++) {
        if (/^\s*#{2,6}\s/.test(section[i]) && section[i].trim() !== FA_SUBHEADING) {
          bEnd = i;
          break;
        }
        if (section[i].trim() === FA_SUBHEADING) fIdx = i;
      }
      if (fIdx === -1) {
        while (bEnd - 1 > fIdx && section[bEnd - 1]?.trim() === "") bEnd -= 1;
        section.splice(bEnd, 0, "", FA_SUBHEADING, "", ...faWanted);
      } else {
        let at = bEnd;
        // Insert before trailing blank lines of the block.
        while (at - 1 > fIdx && section[at - 1]?.trim() === "") at -= 1;
        section.splice(at, 0, ...faWanted);
      }
      for (const l of faWanted) existing.add(bulletIdentity(l));
      added += faWanted.length;
    }
  }

  const next = [...lines.slice(0, headIdx), ...section, ...lines.slice(endIdx)];
  return { text: next.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", added };
}
