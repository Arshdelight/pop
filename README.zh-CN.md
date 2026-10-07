# POP——实践协议（Protocol of Practice）

<a href="README.md">English</a> | <b>中文</b>

一套把实践知识——"怎么做一件事"——定义为开放数据的协议：可发布、可链接、可验证、可组合。

**兼容 skill 生态**：每份 POP 文档都读作一个 skill——action 是原子技能，practice 是组合技能（组合技能的技能）。skill 可**无损映射为**文档（`name`/`description`/正文 → `name`/`description`/`content`，文件 → `attachments`），换来可验证的身份、链接与组合能力。反方向是**投影**：文档的数据流接线、op 组合与修订历史在 skill 侧没有序列化形式——把文档读作 skill 得到的是它的一个视图，而非无损编码。该映射是身份定义、不是导入通道：工具只回放导出物，外来 skill 靠重新撰写进入 POP。

**协议本体：[`pop-spec.md`](pop-spec.md)**——唯一规范性定义，版本 1.1.0。spec 只管协议本身；其余一切都在本仓库。

## 快速开始

```bash
practi init          # 初始化工作区（默认 ~/.practi）
practi new doc.json  # 注册第一份 POP
practi web           # 在本地 web UI 里浏览
```

Agent-first：把 [use-practi skill](skills/use-practi/SKILL.md) 交给你的 AI agent——`practi skill install` 会把它装到 agent 能看到的地方（默认 `~/.agents/skills`），之后的每一次记录 / 检索 / 复盘都由 skill 引导完成。

## 仓库内容

```
pop-spec.md              协议规范
sdk/                     @arshdelight/pop-sdk——官方 SDK + 一致性测试套件
cli/                     practi——`practi` 本地 registry CLI（基于 SDK）
skills/                  可安装的 agent skill（use-practi）
examples/                种子文档
```

**协议只是一套约定**：写实践不需要任何代码——实践就是一份 JSON 文档，起步零哈希。官方 SDK 实现 spec；任何其它实现方——hub、桌面应用、第三方工具——可以基于 SDK，也可以只依 spec 构建。spec 是唯一规范性定义。

## sdk/ — @arshdelight/pop-sdk

解析、哈希、校验与聚合（文档导入、内容寻址存储、聚合视图）的 spec 验证实现。其测试套件兼任一致性 harness：

1. 逐字节复验 Appendix A 测试向量（哈希硬编码在套件中，由 `sdk/scripts/vectors.ts` 再生成）
2. 验证 spec 自洽：导出/导入往返、校验不变式、聚合语义

一方工具（`cli/`）依赖它；正确性由 spec 与向量测试锁死——spec 保持规范地位，不被实现漂移架空。

```bash
npm run build -w @arshdelight/pop-sdk   # dist/——以 @arshdelight/pop-sdk 可导入
npm test -w @arshdelight/pop-sdk        # vitest（含 Appendix A 向量复验）
```

## cli/ — practi（`practi` 命令）

POP 文档的本地管理 CLI：建立在内容寻址工作区之上的个人 registry。数据目录就是一个 POP 工作区（节点内容寻址存于 `nodes/*.md`）；`practi.json` 记录注册的 **direct** 根（indirect = direct POP 引用到的其余全部节点）；学习笔记在旁边的 `notes.json`（仅本地）。

```bash
practi blob add <file-or-url> [--name <name>]
                                  暂存附件：对字节算哈希并存入本地 blob 库。URL 来源经系统代理
                                  抓取，其字节同样入库——指针本身仍只含哈希
practi claim <hash>               把工作区里已存的节点登记为 direct pop（indirect → direct）
practi config                     查看数据目录与 registry 概要
practi edit <hash> <file.json>    编辑 direct POP（产生新哈希；自动留 revision + 回收不可达节点）
practi embed status                报告模型就绪状态与索引覆盖（--json）
practi embed pull                  把离线向量模型取到 <data-dir>/models/
practi embed build [--notes]       构建/刷新向量索引，增量进行——只处理尚未缓存的哈希；
                                   --notes 连本地笔记一起向量化
practi embed prune                 清掉旧模型指纹遗留的向量桶。整层可选：没有模型时 practi
                                   退化为纯词法检索，`search --semantic` 会说明缺什么，
                                   而不是悄悄少召回
practi gc [--apply]                释放孤儿 blob——没有节点引用的附件字节（默认 dry-run；--apply 才删）
practi init [path]                初始化数据目录（默认： ~/.practi）
practi lint [--json] [--limit N]  对全部 direct pop 做记录质量审计：与 `practi new` 创建时打印的
                                  是同一组 W_* 提示，按需可查。只读、永不阻断（退出码恒为 0）
                                  ——是待办清单，不是闸门
practi ls [-a] [--json]           列出 direct POP（-a 连 indirect 节点一起列）
practi migrate [path] [--keep]      把 workspace 剪切到新数据目录（逐文件校验后删除旧目录；
                                   --keep 保留为 .bak 备份；无参 = ~/.practi；带路径则记入
                                   ~/.practi-home 作为默认目录）
practi note add|list|edit|delete  钉在节点哈希上的本地学习笔记（sidecar notes.json）
practi note promote <note-id> [--out <file>]
                                  把一条笔记变回其所属 direct 根的草稿文档，笔记内容拼回当初
                                  钉住的节点位置——只起草、不代你编辑（内容寻址下编辑即新哈希，
                                  拍板权在你）
practi new <file.json>            从 JSON 文档创建 pop（或 --json '<text>'，或 stdin）
practi remove <hash>               把一个 direct 根移出本地目录（注册层操作；回收从剩余 direct
                                   出发不可达的节点——共享的 indirect 节点保得住）
practi repair                     从节点文件 mtime 回补缺失的认领时刻（幂等）
practi search [query...]          搜索全部已存节点——direct、indirect 与孤儿一视同仁：
                                  字段加权 BM25、标题优先排序，`field:` 限定（name: desc:
                                  content: flow: loop: op: hash:），多词 AND 可跨字段命中。
                                  命中结果标注命中的字段；严格匹配无果时放宽到多数词命中
                                  （标注为 relaxed）。--limit N；--json；--notes 连本地笔记
                                  一起进索引（默认关）；--semantic 用向量召回与词法排序融合
                                  （需先 embed pull + build；否则说明缺什么并被忽略）。
                                  空查询 = 浏览 direct 根
practi show <hash> [--json] [--doc]   查看一个节点（hash 前缀即可；--json 的 steps 带正文——一次读完的复现视图）
practi similar <hash> [--limit N] [--json]
                                  内容近邻：以目标子树为查询，对每个已存节点打分，每条命中
                                  列出撑起它命中的共享词。字面匹配（字符 bigram + 拉丁词相关度），
                                  不是语义——换了措辞、不共享字面的不会浮出
practi skill install               安装包内自带的 use-practi skill（默认：~/.agents/skills）
practi skill update                刷新已安装的 use-practi skill（--dir 指定其它 skills 目录）
practi skill uninstall             卸载已安装的 use-practi skill
practi skill import <dir>          把 `practi skill export` 导出的目录回放成 POP（须带 sidecar；外来 skill 靠撰写进入 POP，不做机械导入）
practi skill export <ref> [--dir]  把 POP 投影成可安装的技能目录（SKILL.md + 附件文件 + pop.doc.json sidecar）
practi spec                       打印包内 pop-spec.md（无网络依赖）
practi unclaim <hash>              把仍被引用的 direct pop 退回 indirect（未被引用时报错——
                                   那会孤儿化它；要删除请用 "remove"）
practi update                     经 npm 自更新（检查 registry 最新版）
practi version | --version        查看 CLI 与 pop-spec 协议版本
practi web [--port 4317] [--no-open]  在本地 web UI 浏览 direct pop
```

```bash
npm run build -w @arshdelight/practi
npm link -w @arshdelight/practi   # 全局安装 `practi` 命令
```

两个包同仓为 npm workspace（根目录 `npm install` 即本地互链）。

## 所有权与留存（面向托管 hub）

协议只定义文档；若未来存在托管 hub，由它决定谁拥有文档、存活多久。spec §9.1 记录了 hub 应实现的所有权与留存契约：一个哈希一份（内容寻址去重）、所有权是声明表而非列（direct = 自己上传，indirect = 自己 direct 文档引用的派生节点）、`{ hash }` ChildRef 在存储时解析（绝不存第二份）、零声明 → 可回收。

## 演进

自 1.0.0 起语义化版本：演进尽量只加可选字段（既有身份永不漂移）；破坏性变更升主版本。每次变更遵循：**更新 spec（附新测试向量）→ 一致性通过 → 同步实现方**。

## 版本历史

- **1.1.0**（2026-09-03）——§5.1：行内媒体引用只对节点的附件列表解析；`![caption](https://…)` 外部 URL 目标不再是合法语法（`E_MEDIA_REF`）。外部字节可变、不可审计——审过的链接不会一直是审过的状态。`content` 里的普通 markdown 链接与附件指针可选的 `url` 抓取提示（§5）不变。从未用过外部媒体引用的文档不受影响；哈希不变。
- **1.0.2**（2026-08-27）——§9 不再点名具体认证机制：认证方式及其 scope 一律是 hub 策略。§6 澄清资源守卫（嵌套深度、载荷大小）是实现策略——以 `E_SCHEMA` 拒绝，绝不静默丢弃内容。无格式变更；哈希不受影响。
- **1.0.1**（2026-08-25）——校验澄清（§5.1）：行内代码块是代码，永不扫描其中的媒体语法（围栏代码块此前已是）。无格式变更；哈希不受影响。
- **1.0.0**（2026-08-22）——首发。节点不携带 id：内容哈希是唯一地址，根哈希是整棵树的 Merkle 根（同哈希 ⇒ 同内容，含全部后代）。子节点可内联，也可用 `{ hash }` 引用——身份上可互换。附件是内容寻址 blob，可带外部 url。
