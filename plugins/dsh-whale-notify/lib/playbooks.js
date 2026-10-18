/**
 * @module dsh-whale-notify/playbooks
 *
 * 插件使用手册（playbook）：把「某个插件到底怎么用才对」写成结构化的知识，
 * 让鲸鱼娘不必靠猜、也不必每次重新试错。
 *
 * 为什么单独一个模块：
 *  - `registry.js` 只能告诉模型「有哪些工具、参数是什么」；
 *    它说不出「ssh_connect_profile 需要操作者先开开关」「ssh_list 显示的名字不是
 *    connectionId」「db_* 其实属于 ssh-ops 而不是 dsh-ops」这类**经验**。
 *  - 这些经验目前散落在知识库、历史会话、README 里，模型不会主动去翻。
 *
 * 每条 playbook 包含：
 *  - `entry`：怎么判定要用它（关键词/工具前缀）
 *  - `preconditions`：动手前必须先确认什么（含「不满足时该怎么办」）
 *  - `flow`：推荐步骤（含可直接照抄的调用）
 *  - `pitfalls`：真实踩过的坑（现象 → 原因 → 正确做法）
 *  - `verify`：怎么自证做对了
 *
 * 这里的文本会同时被 `plugin_tools(action:"guide")` 与系统提示词引用，
 * 所以措辞要能直接给模型当指令用。
 */

/** 一条可执行的经验条目。 */
export const PLAYBOOKS = {
  "ssh-ops": {
    title: "dsh-ssh-ops：远程服务器运维",
    package: "dsh-ssh-ops",
    summary:
      "通过 SSH 在远程服务器上执行命令、传文件、开端口隧道，以及连 MySQL/PG/Redis/MongoDB 查询。"
      + "36 个工具：ssh_*（7）、sftp_*（8）、tunnel_*（3）、db_*（14）、终端上下文（2）、批量（1）、会话日志（3）。",
    entry: {
      keywords: ["服务器", "远程", "ssh", "登录服务器", "vps", "云主机", "数据库连接", "mysql", "postgres", "redis", "mongo", "端口转发", "隧道", "传文件", "上传到服务器"],
      toolPrefixes: ["ssh_", "sftp_", "tunnel_", "db_"],
    },
    preconditions: [
      {
        what: "要操作某台服务器，必须先有「当前连接」",
        how: "让操作者在右侧 SSH 面板手动连接，或（开关打开时）你自己调 ssh_connect_profile",
        otherwise:
          "报 `no active SSH connection` / `No SSH connection is currently open` 时，不要反复重试，"
          + "直接请操作者：「请在右侧 SSH 面板里连一下 <服务器名>」。"
          + "如果操作者不在电脑前，改用 notify 通知他，或在会话里等他回来。",
      },
      {
        what: "想按名字连接「已保存的服务器」需要操作者先去设置里打开开关",
        how: "设置 → SSH 资源 → 「允许 AI 自动连接已保存服务器」",
        otherwise:
          "开关关着时 ssh_connect_profile 会明确报「AI 自动连接已保存服务器未开启」。"
          + "此时**不要**改用 ssh_connect 并自己拼密码/私钥 —— 一是你根本拿不到凭据，"
          + "二是把密码写进对话记录是安全事故。正确做法是请操作者打开开关，或让他手动连接。",
      },
      {
        what: "凭据永远不经过你",
        how: "密码/私钥存放在 DSH 凭据库（~/.dsh/.credentials.yaml），Agent 上下文里看不到",
        otherwise: "不要向用户索要密码；也不要建议把密码贴在对话里。",
      },
    ],
    flow: [
      {
        name: "查现状（先看一眼，不要盲连）",
        call: '{"tool":"ssh_list"}',
        note: "返回当前活动连接；开关打开时还会列出已保存的服务器。什么都没返回就是没连。",
      },
      {
        name: "连接（二选一）",
        call: '{"tool":"ssh_connect_profile","arguments":"{\\"resource\\":\\"<服务器名或名字片段>\\"}"}',
        note: "推荐。需要开关已打开。名字支持唯一前缀匹配。",
        alternative: '{"tool":"ssh_connect","arguments":"{\\"host\\":\\"...\\",\\"username\\":\\"...\\",\\"auth\\":{\\"kind\\":\\"key\\",\\"privateKey\\":\\"...\\"}}"}',
        alternativeNote: "仅在操作者当场提供凭据且明确同意时使用；不要自己乱猜。",
      },
      {
        name: "执行命令",
        call: '{"tool":"ssh_exec","arguments":"{\\"command\\":\\"uptime; df -h\\"}"}',
        note: "省略 connection_id 就用当前连接。返回退出码、输出、cwd、耗时、是否截断。",
      },
      {
        name: "交互式场景 / 需要看真实终端",
        call: '{"tool":"ssh_write","arguments":"{\\"input\\":\\"sudo systemctl restart nginx\\"}"}',
        note: "需要输入密码、回答 y/n、进 vim 等交互时用 ssh_write；再用 ssh_read 读回显。",
      },
      {
        name: "传文件",
        call: '{"tool":"sftp_upload_dir","arguments":"{\\"local_path\\":\\"C:\\\\\\\\proj\\\\\\\\dist\\",\\"remote_path\\":\\"/var/www/app\\"}"}',
        note: "小文件并发、大文件独占，单文件失败会逐条上报不中断整批。",
      },
      {
        name: "开隧道（访问服务器内网服务）",
        call: '{"tool":"tunnel_start","arguments":"{\\"kind\\":\\"local\\",\\"bind_port\\":8080,\\"remote_host\\":\\"127.0.0.1\\",\\"remote_port\\":80}"}',
        note: "local = 本机 8080 → 服务器能看到的 127.0.0.1:80。用完 tunnel_stop。",
      },
      {
        name: "连数据库（本机回环地址会自动走当前 SSH 隧道）",
        call: '{"tool":"db_connect","arguments":"{\\"type\\":\\"mysql\\",\\"host\\":\\"127.0.0.1\\",\\"port\\":3306,\\"username\\":\\"root\\",\\"password\\":\\"...\\",\\"database\\":\\"app\\"}"}',
        note: "返回 db_connection_id，后续 db_* 都用它。host 填 127.0.0.1 且已连服务器时会自动隧道到服务器那侧。",
      },
    ],
    pitfalls: [
      {
        symptom: "`ssh_exec failed: connection \"DELL-iStore\" does not exist`",
        cause: "ssh_list / 面板上显示的是**显示名**，不是 connectionId。真实 connectionId 形如 `DELL-iStore-5ea78d49`。",
        fix:
          "别自己拼 connectionId。**省略 connection_id** 让它作用于当前连接即可 —— 这是官方推荐用法，"
          + "也不需要先调 ssh_list。确实要多连接并行时，从 ssh_list 的返回值里取完整 id。",
      },
      {
        symptom: "`No SSH connection is currently open.`",
        cause: "没有任何活动连接；面板里也没开着终端。",
        fix: "请操作者在 SSH 面板连上目标服务器。不要在 pwsh 里试 `ssh user@host` —— 那走本机 OpenSSH，没有凭据，必然 Permission denied。",
      },
      {
        symptom: "`ssh_terminal_sessions` 报 `output.render failed: userRender is not a function`",
        cause: "该工具有渲染缺陷（0.3.22 已确认）。",
        fix: "别用它。要读终端内容直接用 ssh_read；要拿 connectionId 用 ssh_list。",
      },
      {
        symptom: "命令看起来成功但目录不对 / 找不到文件",
        cause: "Linux 上 ssh_exec 会继承交互 shell 的当前目录；终端繁忙或候选不唯一时会退回登录目录（cwd 为 null）。",
        fix: "命令里显式 `cd /目标/目录 && ...`，或先看返回的 `cwd` 字段确认位置。",
      },
      {
        symptom: "想删除远端文件，却没执行",
        cause: "这是设计使然：Agent 发起的删除不会真正删除。",
        fix:
          "简单 rm 会被改写成「移入 ~/.dsh-trash/」（24 小时后过期清理），可在 manifest.tsv 里查到原路径并 mv 回来；"
          + "复合命令 / find -delete / shred 会转成需要操作者点「执行」的确认卡片。如实告知用户即可，不要试图绕过。",
      },
      {
        symptom: "`db_execute` 说 DROP/TRUNCATE 被拦截",
        cause: "高危 SQL 不执行，改为「自动备份 + 隔离改名」。",
        fix: "表会被 RENAME 成 `<表名>_to_be_dropped_<日期>`，数据还在。要真正删除只能由操作者在面板里做。",
      },
      {
        symptom: "`db_query` 拒执行，说不是只读语句",
        cause: "它做词法级真只读闸：只放行 SELECT/SHOW/DESCRIBE/EXPLAIN/纯查询 WITH，拒绝写动词、SELECT INTO、FOR UPDATE、数据修改 CTE。",
        fix: "写操作换 db_execute；Redis/MongoDB 换 db_run。",
      },
      {
        symptom: "查询只回了 200 行",
        cause: "默认流式截断 200 行、30s 超时。",
        fix: "加 LIMIT/OFFSET 分页，或用 db_export 导出；不要盲调大上限。",
      },
      {
        symptom: "`ssh_batch` 没有真的执行",
        cause: "它只创建批量任务，由操作者在面板里勾选服务器并确认后才并发执行。",
        fix: "调用后告诉操作者「请在右侧面板勾选目标服务器并确认」，不要重复调用。",
      },
    ],
    verify: [
      "`ssh_exec` 返回的 `cwd` / 退出码符合预期",
      "改完配置类操作后，用 `ssh_exec` 跑一条验证命令（如 `nginx -t`、`systemctl is-active xxx`）",
      "连数据库后先 `db_list_tables` 或 `db_query \"select 1\"` 确认通",
    ],
  },

  "dsh-ops": {
    title: "dsh-ops：高性能文件检索与 bash",
    package: "dsh-ops",
    summary:
      "Rust 实现的文件工具（更快、输出更省 token）+ 随包 bash（ops_bash）+ 随包 PowerShell 7。"
      + "默认只开 shell 与 file 两个组件；background 与 ptc 组件默认关闭。",
    entry: {
      keywords: ["搜索文件", "grep", "正则", "批量替换", "找文件", "跑命令", "bash", "脚本", "json 输出"],
      toolPrefixes: ["ops_"],
    },
    preconditions: [
      {
        what: "ops_bash 是**严格参数**：只接受 schema 里声明的键",
        how: "command 与 script_path 二选一；另有 description / workdir / timeoutMs / graceMs",
        otherwise:
          "多传一个键（尤其是从宿主 bash/pwsh 习惯带过来的 `run_in_background`）会被**执行前拒绝**，"
          + "错误信息会点出未知键与可用键。不要重试同一个错误参数。",
      },
      {
        what: "ops_bash 没有后台模式",
        how: "它一律前台执行，没有 job id",
        otherwise:
          "服务、监听器、watch 这类常驻进程改用宿主 `pwsh` 的 `run_in_background`，"
          + "或在命令内部自行脱离（`nohup ... & disown`）。否则会一直占着这次调用直到超时。",
      },
      {
        what: "长脚本先落盘再执行",
        how: "超过约 1 KB、或含 heredoc / 大量引号 / 反斜杠 / 中文的多行脚本，先写文件再传 script_path",
        otherwise:
          "把整段 heredoc 塞进 command 会让模型在工具调用 JSON 里做多层转义，"
          + "一轮对话可能整轮因 MALFORMED_RESPONSE 作废。",
      },
    ],
    flow: [
      {
        name: "找文件（比 glob 快，支持多模式与排除）",
        call: '{"tool":"ops_glob","arguments":"{\\"path\\":\\"C:\\\\\\\\proj\\",\\"pattern\\":[\\"**/*.ts\\",\\"!**/node_modules/**\\"]}"}',
        note: "返回 JSON：items / matched / total / truncated / nextOffset，便于分页。",
      },
      {
        name: "搜内容（比 grep 快，支持上下文与计数）",
        call: '{"tool":"ops_grep","arguments":"{\\"pattern\\":\\"TODO|FIXME\\",\\"path\\":\\"src\\",\\"outputMode\\":\\"count\\"}"}',
        note: "outputMode 可选 files_with_matches / content / count / summary。",
      },
      {
        name: "批量替换（先 dryRun 预览）",
        call: '{"tool":"ops_replace","arguments":"{\\"pattern\\":\\"oldName\\",\\"replacement\\":\\"newName\\",\\"glob\\":[\\"**/*.ts\\"],\\"dryRun\\":true}"}',
        note: "确认预览无误后去掉 dryRun 再跑一次。精确单点编辑仍用宿主 edit。",
      },
      {
        name: "读文件（分页/编码/PDF/hex）",
        call: '{"tool":"ops_inspect_local_file","arguments":"{\\"path\\":\\"src/app.ts\\",\\"offset\\":1,\\"limit\\":200}"}',
        note: "大文件用 offset/limit 续读；二进制看 view:hex。",
      },
      {
        name: "跑命令（短）",
        call: '{"tool":"ops_bash","arguments":"{\\"command\\":\\"git status --short && git log --oneline -5\\"}"}',
      },
      {
        name: "跑命令（长脚本）",
        call: '{"tool":"ops_bash","arguments":"{\\"script_path\\":\\"C:\\\\\\\\proj\\\\\\\\build.sh\\",\\"timeoutMs\\":300000}"}',
        note: "先把脚本用 write 写到文件，再传路径。",
      },
    ],
    pitfalls: [
      {
        symptom: "`ops_bash` 报未知键 `run_in_background`",
        cause: "它不支持后台参数（宿主 bash/pwsh 支持，容易混）。",
        fix: "去掉该参数；需要后台就改用 `pwsh` 工具。",
      },
      {
        symptom: "整轮对话报 MALFORMED_RESPONSE / 工具调用 JSON 解析失败",
        cause: "把大段多行脚本或 heredoc 直接塞进 `command`，引号与反斜杠层层转义。",
        fix: "写脚本到文件 → 传 script_path。",
      },
      {
        symptom: "命令一直占着不返回",
        cause: "跑的是常驻进程（server/watch），而 ops_bash 没有后台模式。",
        fix: "改用 `pwsh` 的 `run_in_background`，或 `nohup ... & disown` 自行脱离。",
      },
      {
        symptom: "`ops_bash` 报 ENOENT，找不到 bash",
        cause: "随包 bash 载荷被包管理器清理了；插件默认**不会**静默回退到系统 PATH 的 bash。",
        fix: "用 profile 的 frozen install 或官方插件管理器恢复依赖；不要指望它自动找系统 bash。",
      },
      {
        symptom: "`ops_replace` 没改到文件",
        cause: "read-only 模式拒绝替换；workspace-write 只允许工作区与 DSH 临时目录。",
        fix: "确认路径在工作区内，或请用户放宽权限。",
      },
      {
        symptom: "找不到 `ops_run_background` / `ops_job_*`",
        cause: "background 组件默认关闭，且需要会话是 danger-full-access 才发布。",
        fix: "不需要就该用 `pwsh` 的后台能力；确实需要就请用户在插件设置里打开该组件。",
      },
      {
        symptom: "找不到 `ops_batch` / `ops_result`",
        cause: "PTC 组件默认关闭，只在纯 PTC 会话加载。",
        fix: "普通会话本来就没有，改用多次 ops_bash。",
      },
    ],
    verify: [
      "ops_glob / ops_grep 返回的 JSON 里 `complete: true` 且 `truncated: false` 才算拿全",
      "ops_replace 先 dryRun 看命中数再落盘",
      "ops_bash 看退出码与输出尾部（长输出会被截断到尾部，并给出 spill 路径）",
    ],
  },
};

/**
 * 工具名 → playbook 键。
 *
 * 注意历史错误：`db_*` 曾被标成「dsh-ops（数据库）」，实际上它由 **dsh-ssh-ops** 发布
 * （数据库面板就在 SSH 面板里）。归属错了会让模型去翻错的插件，也可能让用户找错设置项。
 */
export function playbookKeyForTool(name) {
  if (typeof name !== "string") return undefined;
  if (name.startsWith("ssh_") || name.startsWith("sftp_") || name.startsWith("tunnel_") || name.startsWith("db_")) {
    return "ssh-ops";
  }
  if (name.startsWith("ops_")) return "dsh-ops";
  return undefined;
}

/** 取一条 playbook（找不到返回 undefined）。 */
export function getPlaybook(key) {
  return PLAYBOOKS[key];
}

/** 列出全部 playbook 的元信息（给 `plugin_tools(action:"guide")` 做目录用）。 */
export function listPlaybooks() {
  return Object.entries(PLAYBOOKS).map(([key, value]) => ({
    key,
    title: value.title,
    package: value.package,
    summary: value.summary,
    toolCount: null,
  }));
}

/** 按关键词模糊匹配 playbook（用于「用户只说了个大概」时挑选手册）。 */
export function matchPlaybooks(text) {
  const needle = String(text ?? "").toLowerCase();
  if (needle.trim() === "") return [];
  return Object.entries(PLAYBOOKS)
    .filter(([, value]) => {
      const haystack = [
        value.title, value.package, value.summary,
        ...value.entry.keywords,
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    })
    .map(([key]) => key);
}

/**
 * 把一条 playbook 渲染成模型可直接照做的 markdown。
 * @param key - playbook 键。
 * @param options - { toolNames?: string[] } 用于提示该 playbook 覆盖的工具是否真的存在。
 */
export function renderPlaybook(key, options = {}) {
  const book = PLAYBOOKS[key];
  if (book === undefined) return undefined;

  const lines = [];
  lines.push(`# ${book.title}`);
  lines.push("");
  lines.push(book.summary);
  lines.push("");

  if (Array.isArray(options.toolNames) && options.toolNames.length > 0) {
    const prefixes = book.entry.toolPrefixes;
    const present = options.toolNames.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
    lines.push(`**本机实际可用**：${present.length} 个（${present.slice(0, 12).join("、")}${present.length > 12 ? " …" : ""}）`);
    if (present.length === 0) {
      lines.push("> ⚠️ 本机没有检测到该插件的任何工具：可能没装、没启用，或被当前 preset 的 restrict 挡掉了。");
    }
    lines.push("");
  }

  lines.push("## 动手前必须确认");
  for (const item of book.preconditions) {
    lines.push(`- **${item.what}**`);
    lines.push(`  - 做法：${item.how}`);
    if (item.otherwise) lines.push(`  - 不满足时：${item.otherwise}`);
  }
  lines.push("");

  lines.push("## 推荐流程");
  for (const [index, step] of book.flow.entries()) {
    lines.push(`${index + 1}. **${step.name}**`);
    if (step.call) lines.push(`   \`${step.call}\``);
    if (step.note) lines.push(`   ${step.note}`);
    if (step.alternative) {
      lines.push(`   备选：\`${step.alternative}\``);
      if (step.alternativeNote) lines.push(`   （${step.alternativeNote}）`);
    }
  }
  lines.push("");

  lines.push("## 踩过的坑（照着避开）");
  for (const item of book.pitfalls) {
    lines.push(`- **${item.symptom}**`);
    lines.push(`  - 原因：${item.cause}`);
    lines.push(`  - 正确做法：${item.fix}`);
  }
  lines.push("");

  lines.push("## 怎么确认做对了");
  for (const item of book.verify) lines.push(`- ${item}`);
  return lines.join("\n");
}

/**
 * 生成一段精简的系统提示词片段。
 *
 * 只放「最容易做错、且不写就一定会错」的几条，避免把整本手册塞进每轮上下文。
 * 需要细节时由模型自己调 `plugin_tools(action:"guide", playbook:"ssh-ops")`。
 */
export function promptDigest() {
  return [
    "【本机插件用法要点】（细节用 plugin_tools(action:\"guide\") 取）",
    "- `ssh_*` / `sftp_*` / `db_*` 同属 **dsh-ssh-ops** 插件；`ops_*` 属于 **dsh-ops**。别找错地方。",
    "- SSH 一切操作都依赖「当前连接」：省略 connection_id 即作用于当前连接，**不要自己拼 connectionId**"
      + "（面板显示的名字不是 id）。没有当前连接时请操作者在右侧面板连接，不要反复重试、更不要用 pwsh 跑 ssh。",
    "- `ssh_connect_profile` 需要操作者先打开「设置 → SSH 资源 → 允许 AI 自动连接已保存服务器」；"
      + "开关关着时就请他打开或手动连接，**绝不**改用 ssh_connect 自己拼凭据。",
    "- `ssh_terminal_sessions` 有渲染缺陷（userRender 报错），改用 ssh_read / ssh_list。",
    "- `ops_bash` 参数严格、**没有** `run_in_background`；长脚本先写文件再传 script_path；"
      + "常驻进程改用宿主 `pwsh` 的 run_in_background。",
    "- 远端删除与高危 SQL 都被设计成「可恢复」：删除进 ~/.dsh-trash，DROP 转隔离改名。如实说明，不要绕过。",
  ].join("\n");
}
