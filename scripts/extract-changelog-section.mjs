#!/usr/bin/env node
// Extracts one `## [version]` section body from CHANGELOG.md (heading excluded).
//
//   node scripts/extract-changelog-section.mjs v0.8.0 [--changelog PATH]
//
// Prints the section body to stdout. Exits 1 with an actionable error when the
// section is missing — the Android release workflow relies on this to fail
// early instead of publishing a release with generic/empty notes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractChangelogSection } from "./release-notes.mjs";

const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

function usage() {
  console.log("Usage: extract-changelog-section.mjs vMAJOR.MINOR.PATCH [--changelog PATH]");
}

const argv = process.argv.slice(2);
const version = argv.find((a) => !a.startsWith("--"));
const changelogIdx = argv.indexOf("--changelog");
const changelogPath =
  changelogIdx !== -1 ? argv[changelogIdx + 1] : resolve(process.cwd(), "CHANGELOG.md");

if (!version || version === "--help" || version === "-h") {
  usage();
  process.exit(!version ? 2 : 0);
}
if (!TAG_RE.test(version.trim())) {
  console.error(`extract-changelog-section: version must match ^vMAJOR.MINOR.PATCH (got ${JSON.stringify(version)})`);
  process.exit(1);
}
if (changelogIdx !== -1 && !argv[changelogIdx + 1]) {
  console.error("extract-changelog-section: missing value for --changelog");
  process.exit(1);
}

let text;
try {
  text = readFileSync(changelogPath, "utf8");
} catch (err) {
  console.error(`extract-changelog-section: cannot read ${changelogPath}: ${err.message}`);
  process.exit(1);
}

const body = extractChangelogSection(text, version.trim());
if (body === null || body.trim() === "") {
  console.error(
    `extract-changelog-section: no "## [${version.trim()}]" section with content in ${changelogPath}. ` +
      `Run "node scripts/prepare-changelog.mjs --version ${version.trim()}", review, and merge the changelog update before tagging.`,
  );
  process.exit(1);
}
process.stdout.write(body.endsWith("\n") ? body : body + "\n");
