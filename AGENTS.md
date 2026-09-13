# AGENTS.md — instructions for coding agents (Metto)

This file is the canonical repository instruction file for coding agents
working on Metto. Enforcement of the changelog contract below comes from
three things together: this file, `.github/pull_request_template.md`, and
the `release notes (FA/EN)` CI check (`scripts/check-release-notes.mjs`).

## Project essentials

- Bilingual (English / فارسی) Tehran Metro app. User-facing prose must read
  naturally in both languages — plain words, no jargon.
- `main` is the release branch. PRs merge to `main` with normal merge
  commits (squash/rebase also supported — the system does not depend on
  merge strategy).
- Releases: prepare changelog → merge to `main` → `git tag vX.Y.Z` →
  `.github/workflows/android-release.yml` builds the signed Android
  artifacts and publishes the GitHub Release.
- Before submitting: `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Bilingual changelog contract (required)

Every PR must answer one question:

> “Would a normal Metto user notice or care about this change?”

- **Yes → bilingual release notes are required** in the PR body, exactly in
  this shape (keep each language to 1–3 short bullets, roughly ≤ 60 words):

```md
## Release notes
Category: New
### English
- ...
### فارسی
- ...
```

- **No → the PR body must contain exactly** (no changelog entry is generated
  for CI, refactors, dependency maintenance, formatting/lint, internal
  tooling, or docs-only changes):

```md
Release notes: none
```

### `Category` (optional, deterministic)

- Allowed values: `New`, `Improvement`, `Fix`. Omit the line when unsure.
- The value only decides which CHANGELOG group the bullets land in
  (`New / جدید`, `Improvements / بهبودها`, `Fixes / رفع مشکلات`).
- No category → `Uncategorized / بدون دسته‌بندی` bucket, sorted by a human
  during release review. Never invent or reinterpret categories from prose.
- An invalid value fails CI — fix the value or delete the line.

### Examples requiring notes

Features, bug fixes, UI/UX changes, routing changes,
station/timetable/data updates, noticeable performance/offline improvements,
user-visible Android/TWA behavior.

## Release flow (where your snippet goes)

1. User-facing PRs carry bilingual snippets in the **PR body** (source of
   truth). Do NOT edit `CHANGELOG.md` in feature/fix PRs.
2. At release time a maintainer runs
   `node scripts/prepare-changelog.mjs --version vX.Y.Z`, which collects PRs
   merged since the previous tag and drafts the new `CHANGELOG.md` section.
3. The generated section is **reviewed and merged to `main` before tagging**.
4. Tagging triggers the Android release workflow, which takes the matching
   `## [vX.Y.Z]` section from `CHANGELOG.md` as the GitHub Release body and
   fails early if that section is missing.

## Commands

- `node scripts/check-release-notes.mjs --body-file PR_BODY.md` — same check CI runs.
- `node scripts/prepare-changelog.mjs --version vX.Y.Z --dry-run` — preview the next section.
- `node scripts/extract-changelog-section.mjs vX.Y.Z` — print one released section.
- `pnpm changelog:check | changelog:prepare | changelog:extract` — same via package scripts.
