import { mkdir, readFile, readdir, writeFile, rename, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @module dsh-whale-notify/memory
 *
 * 统一记忆库。所有内容都在 `$DSH_HOME/memory/` 下：
 *
 *   conversations/   - 跨会话记忆：一次会话一份总结
 *   summaries/       - 手动保存的总结
 *   friend/          - 群友模式的聊天记忆（JSONL）
 *
 * 搜索按「标题命中 > 标签命中 > 正文命中次数」打分，中文按子串匹配，
 * 不受分词限制；同分时新文件优先。
 */

/** Resolve the unified memory directory. */
export function memoryDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  return join(home, "memory");
}

/** Sub-directories of the memory library (the only searchable categories). */
export const MEMORY_SUBDIRS = {
  conversations: "conversations",
  summaries: "summaries",
  friend: "friend",
};

/** Searchable text-document categories. */
const DOC_CATEGORIES = ["conversations", "summaries"];

/** Slugify a title into a safe filename segment. */
function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "memory";
}

/** Ensure all memory sub-directories exist. */
export async function ensureMemoryDirs() {
  const root = memoryDir();
  await mkdir(root, { recursive: true });
  for (const sub of Object.values(MEMORY_SUBDIRS)) {
    await mkdir(join(root, sub), { recursive: true });
  }
  return root;
}

/**
 * Save a memory document as markdown.
 * @param category - "conversations" | "summaries".
 * @param title - memory title.
 * @param content - markdown body.
 * @param tags - optional keywords (also indexed by the search).
 * @returns the saved file path.
 */
export async function saveMemoryDoc(category, title, content, tags = []) {
  await ensureMemoryDirs();
  const safeCategory = DOC_CATEGORIES.includes(category) ? category : "conversations";
  const stamp = randomUUID().slice(0, 6);
  const path = join(memoryDir(), safeCategory, `${slugify(title)}-${stamp}.md`);
  const tagLine = Array.isArray(tags) && tags.length > 0 ? `tags: ${tags.join(", ")}\n` : "";
  const doc = `# ${title}\n\n${tagLine}---\n\n${content}\n`;
  await writeFile(path, doc, "utf8");
  return path;
}

/** Extract the title / tag line / snippet from one memory document. */
function parseDoc(text, filename) {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? filename.replace(/\.md$/, "");
  const tags = /^tags:\s*(.+)$/m.exec(text)?.[1]?.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) ?? [];
  return { title, tags };
}

/** Count non-overlapping occurrences of needle in haystack (both lowercased by the caller). */
function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 50) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Search memory documents by keyword.
 *
 * 多个关键词用空格分隔时按「全部命中」处理（AND），命中越多分越高。
 * @param query - keyword(s); empty lists the most recently modified documents.
 * @param limit - max results.
 * @returns array of { category, title, path, snippet, score, updatedAt }.
 */
export async function searchMemoryDocs(query, limit = 8) {
  await ensureMemoryDirs();
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  for (const category of DOC_CATEGORIES) {
    const dir = join(memoryDir(), category);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of files) {
      if (!filename.endsWith(".md")) continue;
      const path = join(dir, filename);
      try {
        const text = await readFile(path, "utf8");
        const lower = text.toLowerCase();
        const { title, tags } = parseDoc(text, filename);
        const lowerTitle = title.toLowerCase();
        const lowerTags = tags.join(" ").toLowerCase();

        let score = 0;
        let matchedAll = true;
        for (const term of terms) {
          const inTitle = lowerTitle.includes(term);
          const inTags = lowerTags.includes(term);
          const inBody = countOccurrences(lower, term);
          if (!inTitle && !inTags && inBody === 0) {
            matchedAll = false;
            break;
          }
          score += (inTitle ? 100 : 0) + (inTags ? 40 : 0) + Math.min(inBody, 10) * 3;
        }
        if (!matchedAll) continue;

        const info = await stat(path).catch(() => undefined);
        const bodyStart = text.search(/^---\s*$/m);
        const snippetSource = bodyStart >= 0 ? text.slice(bodyStart + 4) : text;
        results.push({
          category,
          title,
          path,
          score,
          updatedAt: info?.mtimeMs ?? 0,
          snippet: snippetSource.replace(/\s+/g, " ").trim().slice(0, 220),
        });
      } catch {
        // 单个文件读不出来不影响其它结果
      }
    }
  }

  results.sort((a, b) => (b.score - a.score) || (b.updatedAt - a.updatedAt));
  return results.slice(0, limit);
}

/** Read a full memory document by path (rejects paths outside the memory library). */
export async function readMemoryDoc(path) {
  const root = resolve(memoryDir());
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`拒绝读取记忆库之外的路径：${path}`);
  }
  return await readFile(target, "utf8");
}

/** Friend-mode chat memory lives under memory/friend/memory.jsonl. */
export async function appendFriendMemory(entry) {
  await ensureMemoryDirs();
  const path = join(memoryDir(), "friend", "memory.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await writeFile(path, line, { encoding: "utf8", flag: "a" });
}

/** Read recent friend-mode chat memory entries (oldest → newest). */
export async function readFriendMemory(limit = 30, groupId) {
  const path = join(memoryDir(), "friend", "memory.jsonl");
  try {
    const text = await readFile(path, "utf8");
    const rows = text.trim().split("\n").filter(Boolean).slice(-500).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const filtered = groupId === undefined
      ? rows
      : rows.filter((row) => String(row?.groupId ?? "") === String(groupId) || row?.kind === "system");
    return filtered.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Migrate legacy friendmode files (if any) into the unified memory dir.
 * @returns number of migrated files.
 */
export async function migrateLegacyFriendMemory() {
  const legacyDir = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "friendmode");
  await ensureMemoryDirs();
  let migrated = 0;
  try {
    const files = await readdir(legacyDir);
    for (const file of files) {
      if (file === "config.json" || file === "prompts.md") continue; // 这两个仍留在 friendmode
      const src = join(legacyDir, file);
      const dst = join(memoryDir(), "friend", file);
      try {
        await rename(src, dst);
        migrated += 1;
      } catch {
        // 目标已存在或文件被占用：跳过
      }
    }
  } catch {
    // 没有旧目录
  }
  return migrated;
}
