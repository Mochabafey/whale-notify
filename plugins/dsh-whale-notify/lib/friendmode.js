import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @module dsh-whale-notify/friendmode
 *
 * 「群友模式」：QQ 群里以独立人格互动的开关与风格。
 * 状态都在 `$DSH_HOME/friendmode/`：
 *
 *   config.json  - enabled / nickname / readOnly / blacklist { groups:[], users:[] }
 *   prompts.md   - 回复风格提示词（用户可改）
 *
 * 聊天记忆不在这个目录：统一放在 `$DSH_HOME/memory/friend/`（见 memory.js）。
 */

/** Resolve the friend-mode directory. */
export function friendModeDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  return join(home, "friendmode");
}

/** Default reply prompts (user-editable via prompts.md). */
export const DEFAULT_PROMPTS = `# 群友模式回复提示词

以下规则决定鲸鱼娘在 QQ 群里以「群友」身份回复时的风格，可自由编辑。

## 风格
- 回复尽可能简短，像真实的网友聊天，不要像工作汇报。
- 用口语化中文，可以带一点俏皮和网络用语，但别过度。
- 不要每次都解释自己在做什么，直接给出自然的回应。
- 如果不知道说什么，就顺着话题接一句，或者幽默地岔开。
- 纯文本，不要 markdown、不要列表符号。

## 行为
- 只在被 @、被回复/引用、被提到称呼、或私聊时才回应群聊。
- 群聊回复保持 1-2 句话，避免长篇大论。
- 别人没找你时不要主动插话。
- 记住群里聊过的内容（独立记忆），话题相关时可以自然提起。
`;

/** Drop entries the runtime cannot use (empty strings, whitespace). */
function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

/** Normalize a stored config into the shape the rest of the code expects. */
function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === "object" ? raw : {};
  return {
    enabled: config.enabled === true,
    nickname: typeof config.nickname === "string" ? config.nickname : "",
    readOnly: config.readOnly === true,
    blacklist: {
      groups: cleanList(config.blacklist?.groups),
      users: cleanList(config.blacklist?.users),
    },
  };
}

/** Read friend-mode config (creating defaults on first use). */
export async function readFriendConfig() {
  const dir = friendModeDir();
  const path = join(dir, "config.json");
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    const defaults = { enabled: false, nickname: "", readOnly: false, blacklist: { groups: [], users: [] } };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify(defaults, null, 2), "utf8");
    } catch {
      // 写不进去也能用默认值继续
    }
    return defaults;
  }
}

/** Persist friend-mode config (normalized before writing). */
export async function writeFriendConfig(config) {
  const dir = friendModeDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(normalizeConfig(config), null, 2), "utf8");
}

/** Read the reply prompts (creating the default file on first use). */
export async function readFriendPrompts() {
  const dir = friendModeDir();
  const path = join(dir, "prompts.md");
  try {
    const text = await readFile(path, "utf8");
    return text.trim() === "" ? DEFAULT_PROMPTS : text;
  } catch {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, DEFAULT_PROMPTS, "utf8");
    } catch {
      // 读不到就用内置默认
    }
    return DEFAULT_PROMPTS;
  }
}

/** Append one line to the chat memory (stored under memory/friend/). */
export async function appendFriendMemory(entry) {
  const { appendFriendMemory: append } = await import("./memory.js");
  return append(entry);
}

/** Read recent chat memory (stored under memory/friend/). */
export async function readFriendMemory(limit = 30, groupId) {
  const { readFriendMemory: read } = await import("./memory.js");
  return read(limit, groupId);
}

/** Check whether a group/user is blacklisted. */
export function isBlacklisted(config, groupId, userId) {
  const blacklist = config?.blacklist ?? { groups: [], users: [] };
  if (groupId !== undefined && blacklist.groups?.includes(String(groupId))) return true;
  if (userId !== undefined && blacklist.users?.includes(String(userId))) return true;
  return false;
}

/**
 * Build the friend-mode prompt fragment.
 *
 * 记忆按群过滤：在 A 群聊过的内容不该出现在 B 群的回复里（也是隐私问题）。
 * @param config - friend-mode config.
 * @param opts - { groupId?, memoryLimit? }.
 */
export async function buildFriendPrompt(config, opts = {}) {
  const style = await readFriendPrompts();
  const memory = await readFriendMemory(opts.memoryLimit ?? 12, opts.groupId);
  const memoryText = memory.length > 0
    ? `\n\n近期群聊记忆${opts.groupId ? `（群 ${opts.groupId}）` : ""}：\n${memory
        .map((row) => {
          const who = row?.name ?? row?.userId ?? "未知";
          return `- ${who}: ${String(row?.text ?? "").slice(0, 120)}`;
        })
        .join("\n")}`
    : "";
  return `你正在以「群友模式」在 QQ 群里和用户们聊天。你的昵称是「${config.nickname || "鲸鱼娘"}」。
${style}${memoryText}`;
}
