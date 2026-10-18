import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @module dsh-whale-notify/knowledge
 *
 * 技能/知识库：markdown 文档存在 `$DSH_HOME/knowledge/`。
 * 与记忆库分开 —— 记忆是「发生过什么」，知识是「以后该怎么做」。
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
 * Save one skill document.
 * @param title - skill name.
 * @param content - markdown body.
 * @param tags - optional keywords (indexed by search).
 * @returns the saved file path.
 */
export async function saveSkill(title, content, tags = []) {
  const dir = knowledgeDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${slugify(title)}-${randomUUID().slice(0, 6)}.md`);
  const tagLine = Array.isArray(tags) && tags.length > 0 ? `tags: ${tags.join(", ")}\n` : "";
  await writeFile(path, `# ${title}\n\n${tagLine}---\n\n${content}\n`, "utf8");
  return path;
}

/** Count non-overlapping occurrences (both sides already lowercased). */
function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 30) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Search the knowledge base.
 *
 * 多个关键词（空格分隔）按 AND 处理；标题/标签命中权重高于正文。
 * @param query - keyword(s); empty lists everything.
 * @param limit - max results.
 * @returns array of { title, path, snippet, score }.
 */
export async function searchSkills(query, limit = 5) {
  const dir = knowledgeDir();
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const path = join(dir, filename);
    try {
      const text = await readFile(path, "utf8");
      const lower = text.toLowerCase();
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? filename.replace(/\.md$/, "");
      const lowerTitle = title.toLowerCase();
      const tags = (/^tags:\s*(.+)$/m.exec(text)?.[1] ?? "").toLowerCase();

      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        const inTitle = lowerTitle.includes(term);
        const inTags = tags.includes(term);
        const inBody = countOccurrences(lower, term);
        if (!inTitle && !inTags && inBody === 0) { matchedAll = false; break; }
        score += (inTitle ? 100 : 0) + (inTags ? 40 : 0) + Math.min(inBody, 10) * 3;
      }
      if (!matchedAll) continue;

      const bodyStart = text.search(/^---\s*$/m);
      const snippetSource = bodyStart >= 0 ? text.slice(bodyStart + 4) : text;
      results.push({
        title,
        path,
        score,
        snippet: snippetSource.replace(/\s+/g, " ").trim().slice(0, 220),
      });
    } catch {
      // 跳过读不出的文件
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Read a full skill document by path. */
export async function readSkill(path) {
  return await readFile(path, "utf8");
}
