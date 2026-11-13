# 部署与恢复

本指南适用于自行部署，不包含现有服务器的地址、目录或运行数据。

## 安装与启动

在项目根目录执行：

```sh
npm --prefix server ci --ignore-scripts
npm --prefix server/mcp ci --ignore-scripts
npm --prefix server run check
npm --prefix server test
HOST=127.0.0.1 PORT=3000 npm --prefix server start
```

需要局域网访问时将 HOST 设置为 `0.0.0.0`。服务支持 Node.js 18 或更高版本。HTTP 与 WebSocket 使用同一端口；通过反向代理部署时需启用 WebSocket 转发。

## 状态与备份

默认状态文件为 `server/data/state.json`。可通过 `GAMENEST_STATE_FILE` 指定代码目录之外的持久化文件绝对路径。运行用户必须能写入该文件及其父目录，部署新代码时继续使用同一状态文件。

状态包含玩家身份令牌与牌局，不应放入公开目录、仓库或共享日志。备份时先停止服务，将状态文件复制到受限目录，再启动服务。不要用备份覆盖仍在运行的状态文件。

升级前保留旧代码及依赖，在独立临时环境运行测试，并使用状态副本验证迁移：

```sh
cd server
node scripts/verify-migration.js /path/to/copied-state.json
```

迁移验证在临时副本中进行，不修改传入的文件。不要对生产状态执行登录或测试操作。

## 健康检查与关闭

```sh
curl -fsS http://127.0.0.1:3000/api/health
```

健康接口仅返回可用状态和版本。`/api/users`、`/api/debug` 不提供玩家数据。普通玩家 MCP 使用 stdio 或仅监听本机的 HTTP 端点。

服务收到 SIGTERM 后停止接收新请求并关闭连接，最多等待 1.5 秒。成功回执前完成状态持久化；重启后保留已占用席位。损坏的状态文件会阻止启动，应检查备份和日志，不要删除状态文件来绕过错误。

## 回滚

优先回滚代码并保留最新牌局。停止服务后，另存当前状态，再切换到兼容状态格式的旧代码并启动。只有状态文件损坏时才考虑恢复备份；恢复旧快照会丢失备份之后的操作，应由管理员明确选择恢复时刻。
