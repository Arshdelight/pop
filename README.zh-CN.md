# POP——实践协议（Protocol of Practice）

<a href="README.md">English</a> | <b>中文</b>

一套把实践知识——"怎么做一件事"——定义为开放数据的协议：可发布、可链接、可验证、可组合。

**兼容 skill 生态**：每份 POP 文档都读作一个 skill——action 是原子技能，practice 是组合技能（组合技能的技能）。skill 可**无损映射为**文档（`name`/`description`/正文 → `name`/`description`/`content`，文件 → `attachments`），换来可验证的身份、链接与组合能力。反方向是**投影**：文档的数据流接线、op 组合与修订历史在 skill 侧没有序列化形式——把文档读作 skill 得到的是它的一个视图，而非无损编码。

**协议本体：[`pop-spec.md`](pop-spec.md)**——唯一规范性定义，版本 1.0.0。spec 只管协议本身；其余一切都在本仓库。

## 快速开始

把这段提示词发给你的 AI agent——它会装好 [use-pop skill](skills/use-pop/SKILL.md)，其余一切由 skill 引导完成：`pop` CLI、[PractiHub](https://practihub.com) 登录，以及之后的每一次记录 / 检索 / 发布。

```text
安装 use-pop skill（npx skills add Arshdelight/pop -g -y），读取它，并按它的指引为我配置好 pop + PractiHub。
```

## 仓库内容

```
pop-spec.md              协议规范
sdk/                     @arshdelight/pop-sdk——官方 SDK + 一致性测试套件
cli/                     @arshdelight/pop-cli——`pop` 本地 registry CLI（基于 SDK）
skills/                  可安装的 agent skill（use-pop——`npx skills add Arshdelight/pop`）
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
npm test -w @arshdelight/pop-sdk        # vitest（80 例，含 Appendix A 向量复验）
```

## cli/ — @arshdelight/pop-cli（`pop` 命令）

POP 文档的本地管理 CLI：建立在内容寻址工作区之上的个人 registry。数据目录就是一个 POP 工作区（节点内容寻址存于 `nodes/*.md`）；`pop.json` 记录 remote 服务方与注册的 **direct** 根（indirect = direct pop 引用到的其余全部节点）。

```bash
pop init [path]                初始化数据目录（默认： %APPDATA%\pop / ~/.pop）
pop config                     查看数据目录、remote、registry 概要
pop remote set <url>           设置 remote 服务方（如 https://practihub.com）
pop remote show | remove       查看 / 清除 remote
pop ls [-a] [--json]           列出 direct pop（-a 连 indirect 节点一起列）
pop new <file.json>            从 JSON 文档创建 pop（或 --json '<text>'，或 stdin）
pop show <hash> [--json] [--doc]   查看一个节点（hash 前缀即可）
pop web [--port 4317]          在本地 web UI 浏览 direct pop
pop login [--no-open]          对 remote 的 OAuth 登录（打开浏览器）
pop logout                     清除凭据（并在服务端撤销）
pop me                         查看已认证的 remote 用户
pop push [hash]                上传 pop 到 remote（默认：全部 direct；存储为 PRIVATE）
pop pull [hash]                从 remote 拉取 pop（默认：我的全部）
pop search [query...]          搜索 remote 上的 pop（标题优先；空查询 = 浏览最新）
                               [--scope public|me|all] [--limit N] [--json]
pop submit [hash]               提交 pop 进入公开审核（默认：全部 direct）
pop unpublish [hash]            撤回审核 / 把已发布的撤出公开分发
pop delete <hash>               删除自己在 remote 上的 direct 声明（必须给 hash）
pop blob add <file-or-url>     暂存附件（对字节算哈希，本地 blob 入库）
```

```bash
npm run build -w @arshdelight/pop-cli
npm link -w @arshdelight/pop-cli   # 全局安装 `pop` 命令
```

两个包同仓为 npm workspace（根目录 `npm install` 即本地互链）。

## 托管 hub

协议定义文档；hub 决定谁拥有它、存活多久。spec §9.1 记录了我们建议每个托管 hub 实现的所有权与留存契约（Practihub 遵循）：

- **一个哈希一份**——内容寻址去重；同一 root_hash 重复上传幂等。
- **所有权是声明，不是列**——独立的 owner→hash 表；拥有哈希即拥有文档；一份文档可被多个用户拥有。
- **direct 与 indirect 声明**——direct = 自己上传的（进列表、控生命周期）；indirect = 自己 direct 文档引用的内联子节点（派生、不可见）。
- **内联子节点是一等文档**——每个子节点以自己的哈希存储，并被间接声明。
- **ChildRef 子节点复用已存内容**——文档可用 `{ hash }` 引用已存在的子节点而非内联；hub 在存储时解析（哈希缺失 → `E_DANGLING`），绝不存第二份，并间接声明之。与内联在身份上可互换。
- **零声明 → 硬删除**——删除 direct 声明会回收其子节点的 indirect 声明；无任何声明的文档可被回收。

## 演进

自 1.0.0 起语义化版本：演进尽量只加可选字段（既有身份永不漂移）；破坏性变更升主版本。每次变更遵循：**更新 spec（附新测试向量）→ 一致性通过 → 同步实现方**。

## 版本历史

- **1.0.0**（2026-08-22）——首发。节点不携带 id：内容哈希是唯一地址，根哈希是整棵树的 Merkle 根（同哈希 ⇒ 同内容，含全部后代）。子节点可内联，也可用 `{ hash }` 引用——身份上可互换。附件是内容寻址 blob，可带外部 url。
