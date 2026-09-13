#!/usr/bin/env node
// CI check: validates the bilingual release-notes contract on a PR body.
//
//   node scripts/check-release-notes.mjs [--body-file PATH] [--body-text TEXT] [--json]
//   PR_BODY="..." node scripts/check-release-notes.mjs
//   gh pr view 123 --json body -q .body | node scripts/check-release-notes.mjs
//
// Pass: non-empty "## Release notes" with both "### English" and "### فارسی"
// bullets, or exactly "Release notes: none". Exit 0 on pass, 1 on failure.
// Length/bullet-count guidance is reported as warnings (non-failing).
// No LLM, no network — deterministic.
import { readFileSync } from "node:fs";
import { validateReleaseNotes } from "./release-notes.mjs";

function readBody(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--body-file") {
      const path = argv[i + 1];
      if (!path) throw new Error("missing value for --body-file");
      return readFileSync(path, "utf8");
    }
    if (argv[i] === "--body-text") {
      const text = argv[i + 1];
      if (text === undefined) throw new Error("missing value for --body-text");
      return text;
    }
  }
  if (process.env.PR_BODY !== undefined) return process.env.PR_BODY;
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  throw new Error(
    "no PR body provided. Use --body-file, --body-text, pipe via stdin, or set PR_BODY.",
  );
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");

let body;
try {
  body = readBody(argv);
} catch (err) {
  console.error(`check-release-notes: ${err.message}`);
  process.exit(1);
}

const result = validateReleaseNotes(body);

if (asJson) {
  const { parsed, ...rest } = result;
  console.log(
    JSON.stringify({
      ...rest,
      category: parsed.section?.category ?? null,
      english: parsed.section?.english ?? [],
      persian: parsed.section?.persian ?? [],
    }),
  );
} else if (result.ok) {
  if (result.kind === "none") {
    console.log("check-release-notes: OK (internal-only: Release notes: none)");
  } else {
    const { category, english, persian } = result.parsed.section;
    console.log(
      `check-release-notes: OK (${english.length} EN + ${persian.length} FA bullets` +
        `${category ? `, category ${category}` : ", uncategorized — will be sorted in review"})`,
    );
  }
  for (const w of result.warnings) console.log(`check-release-notes: warning: ${w}`);
} else {
  console.error("check-release-notes: FAILED");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
