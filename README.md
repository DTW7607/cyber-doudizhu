# 赛博斗地主

> **穷玩车，富玩表，老钱看AI打斗地主**

三人斗地主网页游戏与 AI 选手比赛工作区，包含可自行运行的网页端 server、观战页面、普通玩家 MCP 和裁判工具。网页端服务源码位于 `server/`，无需连接现有线上服务器即可本地运行。

## 本地运行网页端

需要 Node.js 18 或更高版本及 npm。在项目根目录执行：

```sh
npm --prefix server ci --ignore-scripts
npm --prefix server/mcp ci --ignore-scripts
npm --prefix server start
```

打开 <http://127.0.0.1:3000>。默认监听本机地址，未指定端口且端口被占用时会尝试后续端口，以终端输出为准。需要局域网访问时可运行：

```sh
HOST=0.0.0.0 PORT=3000 npm --prefix server start
```

服务端默认将身份和牌局写入 `server/data/state.json`，可通过 `GAMENEST_STATE_FILE` 指定其他路径。该数据、选手个人目录 `agents/`、比赛运行目录 `runtime/`、依赖和日志不提交到仓库；`server/runtime/` 是必需的服务端源码，随仓库提供。

本地比赛配置可从 `referee/match.example.json` 复制，将 `serverUrl` 设置为 `ws://127.0.0.1:3000`，并为每场比赛设置新的 `matchId`。公开仓库不包含历史比赛记录或现有服务器部署信息。

服务基于 GameNest，保留上游 [Apache-2.0 许可证](server/LICENSE)、[NOTICE](server/NOTICE) 和素材许可，修改记录见 [server/LOCAL-CHANGES.md](server/LOCAL-CHANGES.md)。

裁判负责公共 MCP 和赛程，三个选手各用独立玩家会话。选手的策略与改进方法由其自主决定。

## 资源布局

```text
server/                 # 网页端 server、前端、游戏规则、MCP 与测试
referee/                # 裁判启动器、客户端、配置示例与测试
裁判要求.md             # 裁判执行规则
游戏要求模板.md         # 选手任务模板
agents/                 # 空目录占位；启动比赛后生成个人资料
README.md
.gitignore
```

下面同时列出运行比赛时会生成的目录和文件：

| 路径 | 用途 |
| --- | --- |
| `裁判要求.md` | 裁判执行规则，先启动并验证 MCP，再启动子 agent |
| `游戏要求模板.md` | 自动填入本人 MCP、目录和赛程的完整选手任务 |
| `server/` | 已有游戏服务源码，保留整体结构供 MCP 加载规则 |
| `server/mcp/` | 三名选手共用的一份 MCP 实现与依赖；一人一个运行进程 |
| `referee/` | 公共启动器、通用 MCP 调用客户端、配置示例和集成测试 |
| `runtime/{matchId}/` | 本次端点清单、进程日志与公开计分表；裁判管理 |
| `agents/{name}/{matchId}/` | 新比赛的个人接入说明、工具定义、个人资料 |
| `archives/{matchId}/` | 完成比赛的公开配置、台账和结果 |
| `比赛计分.csv` | 当前或最近一场比赛的公开计分副本 |

`agents/` 通过 `.gitkeep` 保留空目录，个人资料不提交。新比赛统一使用下面的公共设施，启动器会生成所需的个人目录。`runtime/`、`archives/` 和根目录计分表为本地比赛产物，不随公开仓库发布。

## 启动一场比赛

需要 Node.js 和 `server/mcp/` 的依赖。依赖缺失时由裁判运行 `npm --prefix server/mcp ci --ignore-scripts`；不要求选手安装。

1. 参考 `referee/match.example.json` 创建本次配置，设置新的 matchId、三名选手、summaryEvery、totalRounds 和服务器地址。单桌总局数 1–30。
2. 运行 `node referee/start.mjs <配置路径>`，保持该进程运行。它分配三个不同的本机端口，分别启动 MCP，逐一验证工具列表和规则读取，再检查公共大厅可达。**预检不登录玩家、不创建牌桌、不读取手牌。** matchId 不可重复，防止覆盖旧资料。
3. 得到 `status: ready` 后，读取输出中每个选手的 `instructions` 文件，将完整正文作为首次任务交给对应独立子 agent。仅交付本人信息，不共享总清单。启动器负责服务准备，拉起子 agent 由裁判完成。
4. 子 agent 使用其专属原生 MCP，或使用已经提供的 `referee/mcp-call.mjs` 通用客户端。客户端通过 SDK 执行真正的 MCP `tools/list`、`tools/call`，不直接实现另一套游戏 WebSocket 协议。一次命令结束后，服务进程继续保存该选手的身份与连接。
5. 全员报告接入就绪后创建同一牌桌。房主先 `create_room`，再用 `set_option` 设置 `totalRounds`，全员准备后 `start_game`。
6. 比赛期间由裁判维护台账、控制总结暂停与放行。完成后收齐停止确认，用 Ctrl-C 或向启动器发送 SIGTERM 关闭三个 MCP，不执行离桌。

公共入口示例（实际端口以本次生成的接入说明为准）：

```sh
node referee/mcp-call.mjs http://127.0.0.1:端口/mcp list_tools
node referee/mcp-call.mjs http://127.0.0.1:端口/mcp get_rules '{"game":"doudizhu"}'
node referee/mcp-call.mjs http://127.0.0.1:端口/mcp identify '{"name":"本人名字"}'
```

只返回调用结果，不推荐动作。令牌留在 MCP 进程内，不写入公共清单。

## 接入边界

当前桌面会话的子 agent 启动接口没有逐个动态注入 MCP 的参数，所以这里同时交付可直接执行的公共 MCP 客户端，不将生成配置文件误称为工具已挂载。若宿主支持为各子 agent 单独配置 MCP，可使用生成的 `mcp.json`，地址仍指向已启动的同一专属服务，避免重建会话。原生 MCP 的配置方式见 [OpenAI 官方文档](https://developers.openai.com/codex/mcp/)。

每个端点都是普通玩家权限，只监听 `127.0.0.1`。三进程隔离身份；同一机器上的端点不是操作系统级的选手访问隔离，仍须遵守个人目录和本人端点规则。不要公开代理这些无认证端点。裁判只读公开台账和健康信息，不调用选手的手牌接口。

## 验证

```sh
node --test referee/tests/launcher.test.mjs
npm --prefix server run check
npm --prefix server test
```

集成测试使用临时本地游戏服务与临时个人目录，不进入线上牌桌。覆盖三个 MCP 的真实调用、身份独立、同桌开局、对手手牌隐藏、公共客户端跨调用保存会话，以及关闭后的端口释放。
