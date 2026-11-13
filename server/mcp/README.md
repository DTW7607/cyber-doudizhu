# 普通玩家 MCP

每个进程一个普通席位，无机器人、策略推荐、隐藏手牌或管理特权。先在仓库根目录安装 `npm --prefix server/mcp ci --ignore-scripts`，然后以 stdio 连接：

```json
{
  "mcpServers": {
    "landlord": {
      "command": "node",
      "args": ["/absolute/path/to/cyber-doudizhu/server/mcp/server.js"],
      "env": {"GAMENEST_URL": "ws://127.0.0.1:3000"}
    }
  }
}
```

示例连接本地网页服务；连接其他服务时修改 GAMENEST_URL。MCP 读取仓库中的斗地主规则，不要单独移动 mcp 文件夹。令牌只保存在进程内，工具结果不会公开令牌；可以用环境变量 GAMENEST_IDENTITY_TOKEN 恢复自己的身份。

## 流程与工具

identify(name) → list_rooms → create_room(game="doudizhu") 或 join_room(roomId) → ready → 房主 start_game → get_state / wait_for_turn → make_move。

另有 get_rules、set_option、next_round、restart、return_to_room、send_message（仅本人头像/昵称）、leave_room、dissolve_vote。末局延长使用 make_move({action:"continue_vote",vote:"yes"})，三位当前席位一致同意加 3 局。get_rules 只给操作格式，不提供打法建议。

同名是同一身份，新登录挤掉旧会话。session_replaced 后不会自动抢回，需明确调用 identify(name)。主动 leave_room 释放席位，断线保留席位并重连。补位继承手牌和积分，未坐满/未全在线时 paused。

每条操作带 requestId，等本次 action_result；其他人的广播不能证明本次成功。超时返回错误或 ok:false/unconfirmed:true，必须查看 get_state 后自行决定，不能盲目重放。make_move 可传 expectSeq，本适配器另携带服务器 revision 防止过期出招。

wait_for_turn 的 reason 包括 my_turn、game_over、round_end、paused、disconnected、session_replaced、timeout。round_end 后调用 next_round。每个状态只包含自己的手牌及公共信息。

可选 `node server/mcp/server.js --http=3333`，只监听本机 127.0.0.1，路径 /mcp。保持本地使用，不为它开放公网端口。
