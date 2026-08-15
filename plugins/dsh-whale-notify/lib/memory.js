import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @module dsh-whale-notify/memory
 *
 * Unified memory library. Everything lives under `$DSH_HOME/memory/`:
 *
 *   config.json      - memory module config (auto-save flags, etc.)
 *   conversations/   - cross-session memory: one summary doc per conversation
 *   friend/          - friend-mode chat memory (JSONL)
 *   summaries/       - manually saved session summaries (markdown)
 */

/** Resolve the unified memory directory. */
export function memoryDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  return join(home, "memory");
}

/** Sub-directories of the memory library. */
export const MEMORY_SUBDIRS = {
  conversations: "conversations",
  friend: "friend",
  summaries: "summaries",
};

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
 * Save a conversation/summary memory as a markdown document.
 * @param category - "conversations" | "summaries".
 * @param title - memory title.
 * @param content - markdown body.
 * @param tags - optional keywords.
 * @returns the saved file path.
 */
export async function saveMemoryDoc(category, title, content, tags = []) {
  await ensureMemoryDirs();
  const stamp = randomUUID().slice(0, 6);
  const filename = `${slugify(title)}-${stamp}.md`;
  const path = join(memoryDir(), category, filename);
  const tagLine = Array.isArray(tags) && tags.length > 0 ? `tags: ${tags.join(", ")}\n` : "";
  const doc = `# ${title}\n\n${tagLine}---\n\n${content}\n`;
  await writeFile(path, doc, "utf8");
  return path;
}

/**
 * Search all memory documents (conversations + summaries) by keyword.
 * @param query - search keyword (empty = list recent).
 * @param limit - max results.
 * @returns array of { category, title, path, snippet }.
 */
export async function searchMemoryDocs(query, limit = 8) {
  await ensureMemoryDirs();
  const needle = String(query ?? "").toLowerCase();
  const results = [];
  for (const category of ["conversations", "summaries"]) {
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
        const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? filename.replace(/\.md$/, "");
        if (needle !== "" && !text.toLowerCase().includes(needle) && !title.toLowerCase().includes(needle)) continue;
        results.push({ category, title, path, snippet: text.slice(0, 180).replace(/\n+/g, " ") });
        if (results.length >= limit) return results;
      } catch {
        // skip unreadable
      }
    }
  }
  return results;
}

/** Read a full memory document by path. */
export async function readMemoryDoc(path) {
  return await readFile(path, "utf8");
}

/** Friend-mode chat memory (moved under memory/friend/memory.jsonl). */
export async function appendFriendMemory(entry) {
  await ensureMemoryDirs();
  const path = join(memoryDir(), "friend", "memory.jsonl");
  await writeFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { encoding: "utf8", flag: "a" });
}

/** Read recent friend-mode chat memory. */
export async function readFriendMemory(limit = 30) {
  const path = join(memoryDir(), "friend", "memory.jsonl");
  try {
    const text = await readFile(path, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
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
    for (const f of files) {
      if (f === "config.json") continue; // friend config stays in friendmode
      const src = join(legacyDir, f);
      const dst = join(memoryDir(), "friend", f);
      try {
        await rename(src, dst);
        migrated++;
      } catch {
        // already exists or busy
      }
    }
  } catch {
    // no legacy dir
  }
  return migrated;
}
