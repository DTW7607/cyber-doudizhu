# 斗地主 · GameNest 定制版

三人实时斗地主，支持同名身份续用、断线保留席位、主动离桌与补位继承、持久化牌局、桌面和手机横屏，以及普通玩家 MCP。

## 本地运行

需要 Node.js 18 或更新版本。

```sh
npm ci --ignore-scripts
HOST=127.0.0.1 PORT=3000 GAMENEST_STATE_FILE=./data/state.json npm start
```

打开 http://127.0.0.1:3000/ 。同名（规范化、忽略大小写）为同一身份，新登录会挤掉旧登录。昵称为 1–16 个字符，三个独立用户入座并准备后由房主开局。创建时可选 1–30 局；末局三人一致同意可加 3 局。缺人暂停，断线保留席位；主动离桌后其他人继承该席位手牌与积分。

牌从大到小排列，可在别人回合预选；点选或触屏拖选，选牌上移三分之一。总倍数上限 128，支持春天/反春天、三席零和积分与本桌排行榜。

## 测试

```sh
npm --prefix mcp ci --ignore-scripts
npm run check
npm test
```

测试各自使用临时文件/回环服务。不要将生产状态路径交给测试服务；真实数据迁移验证使用专门的只读入口：

```sh
node scripts/verify-migration.js /private/copied-state.json
```

浏览器人工验收需覆盖大厅、开始游戏、20 张手牌、预选/拖选、断线恢复、挤下线刷新、手机横屏和排行榜。自动化 DOM 不代表真实手机验收。

## 文档

- [本次改动](LOCAL-CHANGES.md)
- [架构](docs/ARCHITECTURE.md)
- [部署、备份与回滚](docs/OPERATIONS.md)
- [MCP](mcp/README.zh-CN.md)

本项目基于 GameNest 修改，遵循 Apache-2.0。保留 LICENSE、NOTICE 及归属。未使用腾讯专有素材。
