import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @module dsh-whale-notify/knowledge
 *
 * Persistent skill/knowledge library for the whale-girl learning feature.
 * Skills are stored as markdown documents under `$DSH_HOME/knowledge/`
 * (default `~/.dsh/knowledge`), so they survive plugin updates and restarts.
 */

/** Resolve the knowledge base directory. */
export function knowledgeDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  return join(home, "knowledge");
}

/** Slugify a title into a safe filename segment. */
function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "skill";
}

/**
 * Save one skill document. Appends a short unique suffix to avoid collisions.
 * @param title - skill name/title.
 * @param content - markdown body describing the skill.
 * @param tags - optional keywords for searching.
 * @returns the saved file path.
 */
export async function saveSkill(title, content, tags = []) {
  const dir = knowledgeDir();
  await mkdir(dir, { recursive: true });
  const stamp = randomUUID().slice(0, 6);
  const filename = `${slugify(title)}-${stamp}.md`;
  const path = join(dir, filename);
  const tagLine = Array.isArray(tags) && tags.length > 0 ? `tags: ${tags.join(", ")}\n` : "";
  const doc = `# ${title}\n\n${tagLine}---\n\n${content}\n`;
  await writeFile(path, doc, "utf8");
  return path;
}

/**
 * Search the knowledge base by keyword (title / tags / content substring).
 * @param query - search keyword (empty = list all).
 * @param limit - max results.
 * @returns array of { title, path, snippet }.
 */
export async function searchSkills(query, limit = 5) {
  const dir = knowledgeDir();
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const needle = String(query ?? "").toLowerCase();
  const results = [];
  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const path = join(dir, filename);
    try {
      const text = await readFile(path, "utf8");
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? filename.replace(/\.md$/, "");
      if (needle !== "" && !text.toLowerCase().includes(needle) && !title.toLowerCase().includes(needle)) continue;
      const snippet = text.slice(0, 200).replace(/\n+/g, " ");
      results.push({ title, path, snippet });
      if (results.length >= limit) break;
    } catch {
      // skip unreadable file
    }
  }
  return results;
}

/** Read the full content of a skill document by path. */
export async function readSkill(path) {
  return await readFile(path, "utf8");
}
