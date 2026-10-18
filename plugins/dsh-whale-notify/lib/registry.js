/**
 * @module dsh-whale-notify/registry
 *
 * 插件能力索引：让鲸鱼娘知道「现在这台机器上，除了我自己的工具，还有谁能干什么」，
 * 并且能在同一轮对话里**按需要去调它们**。
 *
 * 为什么需要它：模型看到的只是每个工具的名字和参数，看不到「这个工具属于哪个插件、
 * 要不要前置条件、为什么现在用不了」。于是常见的失败是：
 *  - 明明装了 ssh 插件，却在教用户手动敲命令；
 *  - 想用数据库工具，但不知道要先 `db_connect`；
 *  - 某个工具被 preset 的 restrict 挡掉了，模型只看到「没有这个工具」，不会告诉用户原因。
 *
 * 这里做两件事：
 *  1. `inventory`：把宿主注册表里的工具按「所属插件 + 能力分类」整理成一张表，
 *     并标注它对本会话是否可见、缺什么前置条件。
 *  2. `call`：以当前会话的身份调用一个工具（走完整策略管线：pre-execute →
 *     审批 → 执行），支持在一次工具调用里连续调多个，省掉模型来回多轮的往返。
 *
 * 安全边界（都在代码里硬约束，不靠提示词）：
 *  - 只能调用**本会话可见**的工具（`ctx.tools.get(name, agent)` 有值）；
 *  - 不能调用自己（禁止递归）；
 *  - 嵌套深度上限 `MAX_DEPTH`，超过直接拒绝；
 *  - 子调用继承调用方的 `signal`，外层取消时子调用一起取消；
 *  - 工具自身的审批/沙箱策略照常生效（我们没有绕过 `tools/pre-execute`）。
 */
import { randomUUID } from "node:crypto";

/** 单次 `call` 最多连续调用多少个工具。 */
export const MAX_BATCH = 8;

/** 同一轮里最多嵌套多少层（防止 A 调 B 调 A 的环）。 */
export const MAX_DEPTH = 4;

/** 每个工具结果最多回传多少字符（超出截断并注明）。 */
const MAX_RESULT_CHARS = 12000;

/**
 * 已知工具的能力注释。
 *
 * 这张表只是**注释**，不是白名单：没有登记的工具照样能被列出和调用，
 * 只是少了「属于哪个插件 / 前置条件 / 典型用法」这几句提示。
 * key = 工具名；`match` 用于前缀匹配一组同源工具（ssh_* / sftp_* 等）。
 */
const TOOL_NOTES = {
  // ── 内置：文件与搜索 ──
  read: { owner: "DSH 内置", group: "文件", hint: "读文本文件（带行号，可 offset/limit 续读）" },
  write: { owner: "DSH 内置", group: "文件", hint: "整文件写入 / 覆盖（覆盖前必须先读过）" },
  edit: { owner: "DSH 内置", group: "文件", hint: "按字面量替换做精确编辑，优于整文件重写" },
  glob: { owner: "DSH 内置", group: "文件", hint: "按路径模式找文件" },
  grep: { owner: "DSH 内置", group: "文件", hint: "按正则搜文件内容" },
  ops_inspect_local_file: { owner: "DSH 内置", group: "文件", hint: "读文件的分页/hex 视图" },
  ops_glob: { owner: "DSH 内置", group: "文件", hint: "glob 的 ops 版本，支持 include/exclude 列表" },
  ops_grep: { owner: "DSH 内置", group: "文件", hint: "grep 的 ops 版本，支持上下文行" },
  ops_replace: { owner: "DSH 内置", group: "文件", hint: "批量正则替换（带 dryRun 预览）" },
  ops_bash: { owner: "DSH 内置", group: "命令", hint: "跑 bash 命令/管道/脚本；长脚本用 script_path" },
  pwsh: { owner: "DSH 内置", group: "命令", hint: "跑 PowerShell；Windows 原生命令用这个" },
  working_directory: { owner: "DSH 内置", group: "命令", hint: "读取/切换当前工作目录" },
  load_workspace_dependencies: { owner: "DSH 内置", group: "命令", hint: "拿内置 Python/Node/pnpm 的绝对路径与已装库" },
  todo_write: { owner: "DSH 内置", group: "协作", hint: "多步任务清单，长任务先列再干" },
  present: { owner: "DSH 内置", group: "协作", hint: "把文件声明为交付物（Office/图片等）" },
  ask_user_question: { owner: "DSH 内置", group: "协作", hint: "向用户提问并等选择" },
  ask_user_email: { owner: "鲸鱼通知", group: "协作", hint: "邮件提问，回复自动回会话" },
  subagent_fork: { owner: "DSH 内置", group: "子代理", hint: "开一个继承当前上下文的子代理做子任务" },
  send_message: { owner: "DSH 内置", group: "子代理", hint: "给子代理发消息/继续对话" },
  list_agents: { owner: "DSH 内置", group: "子代理", hint: "列出自己起的子代理及状态" },
  workflow: { owner: "DSH 内置", group: "子代理", hint: "脚本化扇出多个子代理（大批量并行任务）" },
  schedule_create: { owner: "DSH 内置", group: "定时", hint: "在本会话创建提醒/定时任务" },
  schedule_list: { owner: "DSH 内置", group: "定时", hint: "列出本会话的提醒" },
  schedule_update: { owner: "DSH 内置", group: "定时", hint: "修改提醒（保留 id）" },
  schedule_delete: { owner: "DSH 内置", group: "定时", hint: "删除提醒" },
  get_goal: { owner: "DSH 内置", group: "目标", hint: "读当前会话的目标" },
  create_goal: { owner: "DSH 内置", group: "目标", hint: "建立跨轮次持续推进的目标" },
  update_goal: { owner: "DSH 内置", group: "目标", hint: "编辑/暂停/恢复/完成目标" },
  skill: { owner: "DSH 内置", group: "技能", hint: "加载一个技能的完整说明" },

  // ── 内置：网络 ──
  web_search: { owner: "DSH 内置", group: "网络", hint: "联网搜索（多个 query 会合并结果）" },
  web_fetch: { owner: "DSH 内置", group: "网络", hint: "抓取指定 URL 的正文" },

  // ── 鲸鱼通知（本插件）──
  notify: { owner: "鲸鱼通知", group: "通知", hint: "发通知到飞书/QQ/邮件；外部指令完成后用它回执原渠道" },
  whale_check: { owner: "鲸鱼通知", group: "通知", hint: "通知链路自检（渠道/白名单/长连接/会话）" },
  settings: { owner: "鲸鱼通知", group: "配置", hint: "对话内改插件配置（热生效）" },
  friend_mode: { owner: "鲸鱼通知", group: "配置", hint: "QQ 群友模式开关/称呼/黑名单" },
  save_memory: { owner: "鲸鱼通知", group: "记忆", hint: "把本次要点存进统一记忆库" },
  recall_memory: { owner: "鲸鱼通知", group: "记忆", hint: "从记忆库/历史会话恢复上下文" },
  learn_skill: { owner: "鲸鱼通知", group: "记忆", hint: "把一条经验记进知识库" },
  recall_skill: { owner: "鲸鱼通知", group: "记忆", hint: "从知识库检索已记的经验" },
  plugin_tools: { owner: "鲸鱼通知", group: "插件", hint: "本工具：索引并调用其它插件的工具" },

  // ── dsh-ops：数据库与运维 ──
  db_connect: {
    owner: "dsh-ops（数据库）",
    group: "数据库",
    prereq: "连接成功后拿到 db_connection_id",
    hint: "连接 MySQL/PG/openGauss/SQLite/ClickHouse/Redis/MongoDB；本机服务会自动走 SSH 隧道",
  },
  db_query: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "只读查询（只允许 SELECT/SHOW 等）" },
  db_execute: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "写操作（DROP/TRUNCATE 会被拦截为备份+改名）" },
  db_run: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "Redis 命令 / MongoDB 操作" },
  db_preview: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "抽样看表数据" },
  db_describe_table: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "表结构/索引/外键" },
  db_explain: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "执行计划（优化索引前看这个）" },
  db_export: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "导出查询结果为 CSV/JSON" },
  db_list_tables: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "列出当前库的表" },
  db_list_connections: { owner: "dsh-ops（数据库）", group: "数据库", hint: "当前打开的数据库连接" },
  db_disconnect: { owner: "dsh-ops（数据库）", group: "数据库", hint: "关闭数据库连接" },
  db_tx_begin: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_connect", hint: "开事务（配合 tx_execute 验证后 commit）" },
  db_tx_execute: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "先 db_tx_begin", hint: "事务内执行一条语句" },
  db_tx_commit: { owner: "dsh-ops（数据库）", group: "数据库", prereq: "验证无误后", hint: "提交事务" },
  db_tx_rollback: { owner: "dsh-ops（数据库）", group: "数据库", hint: "回滚事务" },

  // ── dsh-ssh-ops：SSH / SFTP / 隧道 ──
  ssh_connect: {
    owner: "dsh-ssh-ops",
    group: "SSH",
    prereq: "连接成功后成为「当前服务器」，后续 ssh_exec 可省略 connection_id",
    hint: "连远程服务器（密码或私钥），并在右侧打开终端",
  },
  ssh_connect_profile: {
    owner: "dsh-ssh-ops",
    group: "SSH",
    prereq: "需要用户在设置里开「允许 AI 自动连接已保存服务器」",
    hint: "按名字连接用户保存的服务器（优先用它，不要自己拼密码）",
  },
  ssh_list: { owner: "dsh-ssh-ops", group: "SSH", hint: "当前连接 + 可用的已保存服务器" },
  ssh_exec: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先 ssh_connect / ssh_connect_profile", hint: "在远程执行命令" },
  ssh_read: { owner: "dsh-ssh-ops", group: "SSH", hint: "读右侧终端的输出缓冲" },
  ssh_write: { owner: "dsh-ssh-ops", group: "SSH", hint: "往终端敲命令/回答交互提示" },
  sftp_list: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "列远程目录" },
  sftp_read: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "读远程文件内容" },
  sftp_write: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "写远程文件" },
  sftp_mkdir: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "建远程目录" },
  sftp_rename: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "移动/改名远程文件" },
  sftp_delete: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接；删除要给用户确认", hint: "删远程文件（需操作员确认）" },
  sftp_upload_dir: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "整目录上传" },
  sftp_download_dir: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "整目录下载" },
  tunnel_start: { owner: "dsh-ssh-ops", group: "SSH", prereq: "先连接", hint: "端口转发（local/remote/SOCKS5）" },
  tunnel_list: { owner: "dsh-ssh-ops", group: "SSH", hint: "当前端口转发" },
  tunnel_stop: { owner: "dsh-ssh-ops", group: "SSH", hint: "停止转发" },
  ssh_batch: { owner: "dsh-ssh-ops", group: "SSH", hint: "对多台已保存服务器下同一条命令（由用户确认目标）" },
  ssh_disconnect: { owner: "dsh-ssh-ops", group: "SSH", hint: "断开当前连接" },
  ssh_shell_integration: { owner: "dsh-ssh-ops", group: "SSH", hint: "给终端开 shell 集成，之后能读 cwd/退出码" },
  ssh_terminal_sessions: { owner: "dsh-ssh-ops", group: "SSH", hint: "列出用户手动开的终端会话" },
  ssh_terminal_context: { owner: "dsh-ssh-ops", group: "SSH", hint: "读用户终端里的一段输出（需授权）" },

  // ── 单位换算 ──
  unit_convert: {
    owner: "dsh-tool-unit-convert",
    group: "计算",
    hint: "长度/质量/温度/数据量/时间/速度换算",
  },

  // ── 插件市场/管理 ──
  plugin_manager: {
    owner: "DSH 插件管理",
    group: "插件",
    prereq: "需要 danger-full-access 或用户批准",
    hint: "列出/启用/禁用/安装/移除 profile 插件",
  },

  // ── Office ──
  office_docx: { owner: "DSH Office", group: "文档", hint: "生成/读取 Word" },
  office_xlsx: { owner: "DSH Office", group: "文档", hint: "生成/读取 Excel（含公式）" },
  office_pptx: { owner: "DSH Office", group: "文档", hint: "生成/读取 PPT" },
  office_export_pdf: { owner: "DSH Office", group: "文档", hint: "Office 转 PDF" },
  office_render: { owner: "DSH Office", group: "文档", hint: "渲染文档为图片检查版面" },
  office_recalculate: { owner: "DSH Office", group: "文档", hint: "重算表格公式并核对结果" },
};

/** 前缀规则：一组同源工具共用一个说明。 */
const PREFIX_NOTES = [
  { prefix: "ssh_", owner: "dsh-ssh-ops", group: "SSH" },
  { prefix: "sftp_", owner: "dsh-ssh-ops", group: "SSH" },
  { prefix: "tunnel_", owner: "dsh-ssh-ops", group: "SSH" },
  { prefix: "db_", owner: "dsh-ops（数据库）", group: "数据库" },
  { prefix: "ops_", owner: "DSH 内置", group: "文件/命令" },
  { prefix: "office_", owner: "DSH Office", group: "文档" },
  { prefix: "schedule_", owner: "DSH 内置", group: "定时" },
  { prefix: "web_", owner: "DSH 内置", group: "网络" },
  { prefix: "ask_user_", owner: "DSH 内置", group: "协作" },
];

/** 找一个工具的注释：精确命中 → 前缀命中 → 兜底。 */
export function noteFor(name) {
  if (TOOL_NOTES[name] !== undefined) return TOOL_NOTES[name];
  for (const rule of PREFIX_NOTES) {
    if (name.startsWith(rule.prefix)) return { owner: rule.owner, group: rule.group };
  }
  return { owner: "其它插件", group: "未分类" };
}

/**
 * 读出「宿主注册表里有什么工具」以及「本会话能用哪些」。
 *
 * 两侧都取是因为它们回答不同的问题：
 *  - `schemas()`（无 scope）= 全局可见集合，包含被 restrict 挡掉的；
 *  - `schemas(agent)` = 本会话真正能调用的集合。
 * 差集就是「装了但用不了」，报出来比让模型瞎猜有用。
 *
 * @param tools - `ctx.tools`（Cordis services）。
 * @param agent - 当前 Agent（可能为空：非会话上下文）。
 * @returns { entries, visibleCount }
 */
export function buildInventory(tools, agent) {
  if (!tools || typeof tools.schemas !== "function") return { entries: [], visibleCount: 0 };

  const safeSchemas = (scope, hasScope) => {
    try {
      return hasScope ? tools.schemas(scope) ?? [] : tools.schemas() ?? [];
    } catch {
      return [];
    }
  };

  const globalSchemas = safeSchemas(undefined, false);
  const scopedSchemas = agent === undefined ? [] : safeSchemas(agent, true);

  const byName = new Map();
  for (const schema of [...globalSchemas, ...scopedSchemas]) {
    if (!schema?.name) continue;
    const existing = byName.get(schema.name);
    // 同一个名字出现两次时，标记为「本会话作用域注册」
    if (existing) {
      existing.visible = true;
      existing.scoped = true;
      continue;
    }
    const note = noteFor(schema.name);
    byName.set(schema.name, {
      name: schema.name,
      description: String(schema.description ?? ""),
      owner: note.owner,
      group: note.group,
      hint: note.hint,
      prereq: note.prereq,
      parameterNames: Object.keys(schema.parameters?.properties ?? {}),
      requiredParams: Array.isArray(schema.parameters?.required) ? schema.parameters.required : [],
      visible: agent === undefined ? true : false,
      scoped: false,
    });
  }
  // 本会话可见的再标一次（上面只在重复注册时标了）
  if (agent !== undefined) {
    for (const schema of scopedSchemas) {
      const entry = schema?.name ? byName.get(schema.name) : undefined;
      if (entry) entry.visible = true;
    }
    for (const entry of byName.values()) {
      // 全局注册且在 agent 视图里也出现了 → 可见。用一个确定的判据：get(name, agent) 有值。
      try {
        if (tools.get(entry.name, agent) !== undefined) entry.visible = true;
      } catch {
        // get 抛错就按不可见处理，下面会说明
      }
    }
  }

  const entries = [...byName.values()].sort((a, b) => (
    a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group, "zh")
  ));
  return { entries, visibleCount: entries.filter((entry) => entry.visible).length };
}

/** 把一个工具结果压成可读文本（content 里是 text/图片块）。 */
export function renderToolContent(content, limit = MAX_RESULT_CHARS) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[图片]");
    else if (block?.type === "file") parts.push(`[文件 ${block.attachment?.name ?? ""}]`);
    else if (block?.type) parts.push(`[${block.type}]`);
  }
  const text = parts.join("\n").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（结果过长已截断，共 ${text.length} 字）`;
}

/** 一个不可能成功的名字用来给子调用造 callId。 */
function subCallId() {
  return `whale-pt-${randomUUID()}`;
}

/**
 * 以当前会话身份调用一个工具。
 *
 * 不绕过任何策略：`ctx.tools.execute` 会照常跑 `tools/pre-execute`（含审批）、
 * 单调 guard、`tools/execute` 包装器。这里只是把「模型的一次调用」变成
 * 「插件发起的一次嵌套调用」。
 *
 * @param tools - `ctx.tools`.
 * @param opts - { agent, signal, parentToken, rootCallId, depth }.
 * @param name - 目标工具名。
 * @param args - 目标工具参数。
 * @returns { ok, isError, text, name }
 */
export async function callTool(tools, opts, name, args) {
  const { agent, signal, parentToken, rootCallId, depth = 0 } = opts ?? {};

  if (!tools || typeof tools.execute !== "function") {
    return { ok: false, isError: true, name, text: "宿主的 tools 服务不可用，无法调用工具。" };
  }
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, isError: true, name: String(name), text: "工具名不能为空。" };
  }
  if (name === "plugin_tools") {
    return { ok: false, isError: true, name, text: "plugin_tools 不能调用自己（会无限递归）。要组合工具，请在一次调用里用 call 的多个步骤。" };
  }
  if (depth >= MAX_DEPTH) {
    return { ok: false, isError: true, name, text: `嵌套调用超过 ${MAX_DEPTH} 层，已拒绝（疑似循环）。` };
  }

  // 可见性检查：不可见的工具交给 execute 也只会得到 UNKNOWN_TOOL，
  // 但这里给出人能读懂的原因更有价值。
  let visible;
  try {
    visible = agent === undefined ? tools.get(name) : tools.get(name, agent);
  } catch {
    visible = undefined;
  }
  if (visible === undefined) {
    return {
      ok: false,
      isError: true,
      name,
      text: `工具「${name}」对本会话不可见：可能没装对应插件、插件没启用，或被当前 preset 的 restrict 限制掉了。用 plugin_tools(list) 看可用清单。`,
    };
  }

  const exec = {
    callId: subCallId(),
    name,
    arguments: args ?? {},
  };
  if (agent !== undefined) exec.agent = agent;
  if (signal !== undefined) exec.signal = signal;
  // parent token 让嵌套调用在 PTC 模式下也能落到底层工具上（与 run_code 的 SDK 调用同一机制）。
  if (parentToken !== undefined) exec.parent = parentToken;
  if (rootCallId !== undefined) exec.rootCallId = rootCallId;

  try {
    const result = await tools.execute(exec);
    const text = renderToolContent(result?.content) || (result?.isError ? "（失败，但没有返回内容）" : "（无输出）");
    // value 是工具的规范返回值（模型看到的 content 是渲染结果）。
    // 上层拿它做 $N.field 引用，比让模型从渲染文本里再抠一次更可靠。
    return { ok: true, isError: result?.isError === true, name, text, value: result?.value };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      name,
      text: `调用「${name}」抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Matches a whole-string `$N` or `$N.path.to.field` reference. */
const VALUE_REF = /^\$(\d+)(?:\.([A-Za-z0-9_.[\]]+))?$/;

/** Convert a camelCase / snake_case / kebab-case key into its alphanumeric lowercase form. */
function normalizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * Find a field on an object whose name differs only in case style.
 *
 * 真实用例：`db_connect` 的规范返回值是 `{ dbConnectionId }`，而模型按
 * 参数名会写 `$0.db_connection_id`。两边指同一个东西，硬报错只会浪费一轮对话，
 * 所以这里按「去掉分隔符后小写相同」做一次宽容匹配，并在结果里说明改正了什么。
 */
function findLooseKey(object, key) {
  if (object === null || typeof object !== "object") return undefined;
  const wanted = normalizeKey(key);
  for (const candidate of Object.keys(object)) {
    if (normalizeKey(candidate) === wanted) return candidate;
  }
  return undefined;
}

/**
 * Resolve `$N.path` against the values collected so far.
 * @param text - the whole reference string.
 * @param values - canonical values of previous steps.
 * @param notes - optional array collecting human-readable corrections.
 */
function resolveRef(text, values, notes) {
  const match = VALUE_REF.exec(text);
  if (!match) return undefined;
  const index = Number(match[1]);
  const base = values[index];
  if (base === undefined) {
    throw new Error(`引用了 $${index}，但第 ${index + 1} 步没有可用的返回值（它失败了或是第一步之前）`);
  }
  if (match[2] === undefined) return base;

  const path = match[2].replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cursor = base;
  for (const key of path) {
    if (cursor === null || cursor === undefined) {
      throw new Error(`$${index}.${match[2]} 不存在：路径上 ${key} 的前一段是空值`);
    }
    let actual = key;
    if (Array.isArray(cursor)) {
      const position = Number(key);
      if (!Number.isInteger(position) || position < 0 || position >= cursor.length) {
        throw new Error(`$${index}.${match[2]} 越界：数组长度 ${cursor.length}，下标 ${key}`);
      }
      actual = position;
    } else if (!Object.prototype.hasOwnProperty.call(cursor, key)) {
      const loose = findLooseKey(cursor, key);
      if (loose === undefined) {
        throw new Error(`$${index}.${match[2]} 不存在；可用字段：${Object.keys(cursor).join(", ") || "（无）"}`);
      }
      notes?.push(`$ ${index}.${key} → 实际字段是 ${loose}`);
      actual = loose;
    }
    cursor = cursor[actual];
  }
  if (cursor === undefined) {
    throw new Error(`$${index}.${match[2]} 不存在；可用字段：${Object.keys(base ?? {}).join(", ") || "（无）"}`);
  }
  return cursor;
}

/**
 * Parse one step's `arguments` string and substitute `$N.path` references.
 *
 * 允许三种写法：
 *  - JSON 对象字符串：`{"sql":"select 1"}`
 *  - 空 / 省略：`{}`
 *  - 字符串值里以 `$N.path` 整串出现时替换成上一步的规范值（数字/布尔不会被字符串化）。
 *
 * @param raw - the authored argument string.
 * @param values - canonical values of previous steps, indexed by step.
 * @param notes - optional array collecting field-name corrections.
 * @returns the argument object.
 */
export function parseStepArguments(raw, values, notes) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return {};
  const text = String(raw).trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(text.startsWith("{") || text.startsWith("[") ? error.message : "需要是 JSON 对象，例如 {\"path\":\"./a.txt\"}");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("参数必须是 JSON 对象（不是数组或标量）");
  }
  const substitute = (value) => {
    if (typeof value === "string") {
      const resolved = resolveRef(value, values, notes);
      return resolved === undefined ? value : resolved;
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value !== null && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = substitute(item);
      return out;
    }
    return value;
  };
  return substitute(parsed);
}

/**
 * 按分类汇总一张紧凑清单（给 `list` 用）。
 * @param entries - buildInventory 的结果。
 * @param options - { group?, onlyVisible?, keyword? }.
 */
export function summarizeInventory(entries, options = {}) {
  const { group, onlyVisible = true, keyword } = options;
  const needle = typeof keyword === "string" ? keyword.toLowerCase() : "";
  const filtered = entries.filter((entry) => {
    if (onlyVisible && !entry.visible) return false;
    if (group !== undefined && entry.group !== group) return false;
    if (needle !== "") {
      // 参数名也参与匹配：用户说「查一下 sql / 连 host」时，靠参数名比靠中文描述更容易命中。
      const haystack = [
        entry.name, entry.owner, entry.group, entry.hint ?? "", entry.description,
        ...(entry.parameterNames ?? []),
      ].join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const groups = new Map();
  for (const entry of filtered) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([name, list]) => ({ group: name, entries: list }));
}
