#!/usr/bin/env node
/**
 * garden.mjs — link + URL integrity for the digital garden.
 *
 * Two jobs:
 *
 *   aliases   Detect notes that moved or were renamed, and append their OLD
 *             published URL to the note's `aliases:` frontmatter. The
 *             alias-redirects plugin turns each one into a redirect stub, so
 *             external links and bookmarks keep working forever.
 *
 *   check     Fail if the garden has broken internal structure:
 *               - dangling [[wikilinks]] pointing at nothing
 *               - duplicate filenames (ambiguous under `shortest` resolution)
 *               - notes missing frontmatter
 *
 * Usage:
 *   node scripts/garden.mjs aliases [--staged] [--dry-run]
 *   node scripts/garden.mjs check
 *
 * Why aliases must be written pre-slugified and lowercase:
 * alias-redirects (.quartz/plugins/alias-redirects/src/emitter.ts) uses the
 * alias value VERBATIM as a full slug unless it starts with ./ or ../ — it
 * does not slugify it for you. So we emit exactly what slugifyFilePath would
 * have produced for the old path.
 */

// Deliberately dependency-free: this runs from a git hook and from CI before
// `npm ci`, so it cannot rely on anything in node_modules.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()

// Folders Quartz never publishes — keep them out of every check.
// Mirrors `ignorePatterns` in quartz.config.yaml.
const IGNORED = new Set([
  "00-Inbox",
  "Templates",
  ".obsidian",
  ".github",
  ".git",
  "quartz",
  "node_modules",
  "public",
  ".quartz",
  "private",
  "scripts",
  "CLAUDE.md", // agent instructions, not a note (gitignored, local only)
])

// ---------------------------------------------------------------------------
// Slug rules — must match @quartz-community/utils slugifyPath() exactly.
// See node_modules/@quartz-community/utils/dist/path.js
// ---------------------------------------------------------------------------

function slugifySegment(segment) {
  return segment
    .replace(/\s/g, "-")
    .replace(/&/g, "-and-")
    .replace(/%/g, "-percent")
    .replace(/\?/g, "")
    .replace(/#/g, "")
    .toLowerCase()
}

/** Turn a repo-relative file path into the URL slug Quartz will serve it at. */
export function slugifyFilePath(fp) {
  const withoutExt = fp.replace(/\.md$/i, "")
  let slug = withoutExt.split("/").map(slugifySegment).join("/").replace(/\/$/, "")

  if (slug.endsWith("_index")) slug = slug.replace(/_index$/, "index")

  // Obsidian folder-note convention: folder/folder.md is the folder's landing page
  const segments = slug.split("/")
  if (segments.length >= 2 && segments.at(-1) === segments.at(-2)) {
    segments[segments.length - 1] = "index"
    slug = segments.join("/")
  }
  return slug
}

// ---------------------------------------------------------------------------
// Repo walking
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
}

function isIgnored(relPath) {
  const first = relPath.split("/")[0]
  return IGNORED.has(first) || first.startsWith(".")
}

function allNotes(dir = ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full).split(path.sep).join("/")
    if (isIgnored(rel)) continue
    if (entry.isDirectory()) allNotes(full, acc)
    else if (entry.name.endsWith(".md")) acc.push(rel)
  }
  return acc
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function splitFrontmatter(text) {
  if (!text.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  if (end === -1) return null
  const closeEnd = text.indexOf("\n", end + 1)
  return {
    block: text.slice(0, closeEnd + 1),
    body: text.slice(closeEnd + 1),
  }
}

/**
 * Read existing aliases.
 *
 * Parsed as real YAML rather than split on commas: a quoted value that itself
 * contains a comma ("ai/ai-is-a-tool,-not-magic") must stay one alias. Naive
 * splitting turns it into two bogus ones and then re-appends the real one on
 * every run.
 */
function readAliases(block) {
  const inline = block.match(/^aliases:\s*\[(.*)\]\s*$/m)
  if (inline) return splitFlowSeq(inline[1])

  const blockList = block.match(/^aliases:\s*\n((?:\s*-\s*.+\n)+)/m)
  if (blockList) {
    return blockList[1]
      .split("\n")
      .map((l) => unquote(l.replace(/^\s*-\s*/, "").trim()))
      .filter(Boolean)
  }
  return []
}

function unquote(s) {
  const m = s.match(/^(["'])([\s\S]*)\1$/)
  return m ? m[2] : s
}

/**
 * Split a YAML flow sequence on commas that are NOT inside quotes, so
 * "ai/ai-is-a-tool,-not-magic" stays a single entry.
 */
function splitFlowSeq(s) {
  const out = []
  let cur = ""
  let quote = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ",") {
      out.push(cur.trim())
      cur = ""
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out.filter(Boolean)
}

/**
 * Write an aliases list back, replacing any existing entry.
 * Values are always quoted: a note title containing a comma (e.g.
 * "AI Is a Tool, Not Magic") would otherwise be read by YAML as two separate
 * list items, producing two wrong redirects and losing the real one.
 */
function writeAliases(block, aliases) {
  const quoted = aliases.map((a) => `"${a.replace(/"/g, '\\"')}"`)
  const line = `aliases: [${quoted.join(", ")}]\n`
  if (/^aliases:\s*\[.*?\]\s*$/m.test(block)) {
    return block.replace(/^aliases:\s*\[.*?\]\s*$/m, line.trimEnd())
  }
  if (/^aliases:\s*\n(?:\s*-\s*.+\n)+/m.test(block)) {
    return block.replace(/^aliases:\s*\n(?:\s*-\s*.+\n)+/m, line)
  }
  // Insert directly after the opening `---`
  const nl = block.indexOf("\n")
  return block.slice(0, nl + 1) + line + block.slice(nl + 1)
}

// ---------------------------------------------------------------------------
// Command: aliases
// ---------------------------------------------------------------------------

function cmdAliases({ staged, dryRun, since }) {
  // --staged  : uncommitted, staged renames (used by the pre-commit hook)
  // --since X : renames between commit X and now (used by CI, e.g. HEAD~1)
  // default   : uncommitted renames in the working tree
  const args = staged
    ? ["diff", "--cached", "-M", "--diff-filter=R", "--name-status"]
    : since
      ? ["diff", "-M", "--diff-filter=R", "--name-status", since, "HEAD"]
      : ["diff", "-M", "--diff-filter=R", "--name-status", "HEAD"]

  const out = git(args).trim()
  if (!out) {
    console.log("No renamed or moved notes detected.")
    return 0
  }

  let changed = 0
  for (const line of out.split("\n")) {
    const [status, oldPath, newPath] = line.split("\t")
    if (!status?.startsWith("R") || !oldPath?.endsWith(".md")) continue
    if (isIgnored(oldPath) || isIgnored(newPath)) continue

    const oldSlug = slugifyFilePath(oldPath)
    const newSlug = slugifyFilePath(newPath)
    if (oldSlug === newSlug) continue // pure case change, no redirect needed

    const abs = path.join(ROOT, newPath)
    const text = fs.readFileSync(abs, "utf8")
    const fm = splitFrontmatter(text)
    if (!fm) {
      console.warn(`  ! ${newPath} — no frontmatter, skipped`)
      continue
    }

    const existing = readAliases(fm.block)
    if (existing.includes(oldSlug)) continue

    // Append-only. Old aliases are never removed, so a note that moves
    // repeatedly keeps every URL it has ever been served at.
    const updated = [...existing, oldSlug]
    console.log(`  + ${newPath}`)
    console.log(`      alias: ${oldSlug}`)

    if (!dryRun) {
      fs.writeFileSync(abs, writeAliases(fm.block, updated) + fm.body)
      try {
        git(["add", newPath])
      } catch {
        /* running outside a staging context (e.g. CI) — the caller commits */
      }
    }
    changed++

    // A MOVE keeps the filename, so [[Name]] still resolves under `shortest`.
    // A RENAME changes it, which silently breaks every [[Old Name]] in the
    // garden — so rewrite those to the new name.
    const oldName = path.basename(oldPath, ".md")
    const newName = path.basename(newPath, ".md")
    if (oldName !== newName) {
      const rewrites = rewriteWikilinks(oldName, newName, dryRun)
      console.log(
        `      renamed: [[${oldName}]] -> [[${newName}]] in ${rewrites} file(s)`,
      )
    }
  }

  console.log(
    changed === 0
      ? "No new aliases needed."
      : `${changed} note(s) given redirect aliases${dryRun ? " (dry run — nothing written)" : ""}.`,
  )
  return 0
}

/**
 * Rewrite [[oldName]] -> [[newName]] across every note, preserving any
 * display alias ([[old|label]]) and anchor ([[old#section]]).
 * Returns the number of files touched.
 */
function rewriteWikilinks(oldName, newName, dryRun) {
  let touched = 0
  for (const rel of allNotes()) {
    const abs = path.join(ROOT, rel)
    const text = fs.readFileSync(abs, "utf8")
    const updated = text.replace(/\[\[([^\]]+)\]\]/g, (full, inner) => {
      const [targetPart, ...labelParts] = inner.split("|")
      const [target, ...anchorParts] = targetPart.split("#")
      if (target.trim() !== oldName) return full
      const anchor = anchorParts.length ? "#" + anchorParts.join("#") : ""
      // Keep the words that were on the page. A bare [[Docker]] becomes
      // [[Containers|Docker]] rather than [[Containers]], so the link is
      // retargeted without rewriting the surrounding sentence.
      const label = labelParts.length ? labelParts.join("|") : oldName
      return `[[${newName}${anchor}|${label}]]`
    })
    if (updated !== text) {
      if (!dryRun) {
        fs.writeFileSync(abs, updated)
        git(["add", rel])
      }
      touched++
    }
  }
  return touched
}

// ---------------------------------------------------------------------------
// Command: check
// ---------------------------------------------------------------------------

function cmdCheck({ strict }) {
  const notes = allNotes()
  const problems = []

  // Map basename -> [slugs], for `shortest` link resolution
  const byName = new Map()
  const allSlugs = new Set()
  const aliasSlugs = new Set()

  for (const rel of notes) {
    const slug = slugifyFilePath(rel)
    allSlugs.add(slug)
    const name = slug.split("/").at(-1)
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(rel)

    const text = fs.readFileSync(path.join(ROOT, rel), "utf8")
    const fm = splitFrontmatter(text)
    if (!fm) {
      problems.push(`missing frontmatter: ${rel}`)
      continue
    }
    for (const a of readAliases(fm.block)) aliasSlugs.add(a.toLowerCase())
  }

  // Duplicate filenames make [[Name]] ambiguous under `shortest` resolution
  for (const [name, files] of byName) {
    if (files.length > 1) {
      problems.push(`ambiguous name "${name}" — ${files.join(", ")}`)
    }
  }

  // Dangling wikilinks
  const linkRe = /\[\[([^\]]+)\]\]/g
  for (const rel of notes) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8")
    for (const m of text.matchAll(linkRe)) {
      let target = m[1].split("|")[0].split("#")[0].trim()
      if (!target) continue
      if (target.endsWith("/")) continue // folder link, resolved by folder-page

      const slug = slugifyFilePath(target)
      const name = slug.split("/").at(-1)
      const resolves =
        allSlugs.has(slug) || byName.has(name) || aliasSlugs.has(slug)
      if (!resolves) problems.push(`dangling link [[${target}]] in ${rel}`)
    }
  }

  const dangling = problems.filter((p) => p.startsWith("dangling"))
  const structural = problems.filter((p) => !p.startsWith("dangling"))

  console.log(`Checked ${notes.length} notes.`)

  // Dangling links are NORMAL in a garden — they are seeds for notes not yet
  // written. They are reported, but only fail the build under --strict.
  if (dangling.length) {
    console.log(`\n${dangling.length} dangling link(s) (unwritten notes — informational):`)
    if (strict) for (const p of dangling) console.log(`  - ${p}`)
  }

  if (structural.length) {
    console.log(`\n${structural.length} STRUCTURAL problem(s):`)
    for (const p of structural) console.log(`  - ${p}`)
  }

  if (structural.length) return 1
  if (strict && dangling.length) return 1
  console.log("\nNo structural problems.")
  return 0
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2)
const flags = new Set(rest)
const sinceIdx = rest.indexOf("--since")
const since = sinceIdx !== -1 ? rest[sinceIdx + 1] : undefined

let code = 0
switch (cmd) {
  case "aliases":
    code = cmdAliases({
      staged: flags.has("--staged"),
      dryRun: flags.has("--dry-run"),
      since,
    })
    break
  case "check":
    code = cmdCheck({ strict: flags.has("--strict") })
    break
  default:
    console.log("usage: node scripts/garden.mjs <aliases|check> [--staged] [--dry-run]")
    code = 1
}
process.exit(code)
