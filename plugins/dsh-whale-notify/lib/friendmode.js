import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @module dsh-whale-notify/friendmode
 *
 * "群友模式" (friend mode): an independent QQ group-chat persona with its own
 * nickname, blacklist, chat memory, and reply prompts. All state lives under
 * `$DSH_HOME/friendmode/` as editable files:
 *
 *   config.json  - enabled, nickname, readOnly, blacklist { groups:[], users:[] }
 *   prompts.md   - reply style prompts (user-editable)
 *   memory.jsonl - independent chat memory log
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

## 行为
- 只在被 @、被回复/引用、被提到称呼、或私聊时才回应群聊。
- 群聊回复保持 1-2 句话，避免长篇大论。
- 别人没找你时不要主动插话。
- 记住群里聊过的内容（独立记忆），话题相关时可以自然提起。
`;

/** Read friend-mode config (creating defaults on first use). */
export async function readFriendConfig() {
  const dir = friendModeDir();
  const path = join(dir, "config.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    const defaults = {
      enabled: false,
      nickname: "",
      readOnly: false,
      blacklist: { groups: [], users: [] },
    };
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
}

/** Persist friend-mode config. */
export async function writeFriendConfig(config) {
  const dir = friendModeDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2), "utf8");
}

/** Read the reply prompts (creating the default file on first use). */
export async function readFriendPrompts() {
  const dir = friendModeDir();
  const path = join(dir, "prompts.md");
  try {
    return await readFile(path, "utf8");
  } catch {
    await mkdir(dir, { recursive: true });
    await writeFile(path, DEFAULT_PROMPTS, "utf8");
    return DEFAULT_PROMPTS;
  }
}

/** Append one line to the independent chat memory. */
export async function appendFriendMemory(entry) {
  const dir = friendModeDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "memory.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    { encoding: "utf8", flag: "a" },
  );
}

/** Read recent chat memory (last N lines). */
export async function readFriendMemory(limit = 30) {
  const dir = friendModeDir();
  try {
    const text = await readFile(join(dir, "memory.jsonl"), "utf8");
    const lines = text.trim().split("\n").filter(Boolean).slice(-limit);
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Check whether a group/user is blacklisted. */
export function isBlacklisted(config, groupId, userId) {
  const blacklist = config?.blacklist ?? { groups: [], users: [] };
  if (groupId && blacklist.groups?.includes(String(groupId))) return true;
  if (userId && blacklist.users?.includes(String(userId))) return true;
  return false;
}

/** Build the friend-mode system prompt fragment. */
export async function buildFriendPrompt(config) {
  const style = await readFriendPrompts();
  const memory = await readFriendMemory(10);
  const memoryText = memory.length > 0
    ? `\n近期群聊记忆：\n${memory.map((m) => `- ${m.userId}: ${m.text}`).join("\n")}`
    : "";
  return `你正在以「群友模式」在 QQ 群里和用户们聊天。你的昵称是「${config.nickname || "鲸鱼娘"}」。
${style}${memoryText}`;
}
