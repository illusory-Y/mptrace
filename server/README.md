# 信令服务运维说明

只做两件事：维护「6 位配对码房间」、在房间两端之间透传 WebRTC 协商消息。
**不接收、不缓存、不记录任何文件内容。**

## 启动

```bash
npm install
cp .env.example .env   # 按需修改
npm start              # 生产
npm run dev            # 本地 watch 模式
```

健康检查：`GET /health` → `{ok:true,rooms,peers}`，可挂监控。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 8787 | 监听端口 |
| WS_PATH | /ws | WebSocket 路径 |
| CODE_TTL_MS | 300000 | 配对码有效期，固定 5 分钟 |
| STUN_URL | stun.l.google.com | 下发给客户端的 STUN，逗号分隔 |
| TURN_URL | 空 | TURN 入口，逗号分隔 udp/tcp/tls |
| TURN_USERNAME / TURN_CREDENTIAL | 空 | Coturn 长期凭据 |
| TRUST_PROXY | false | 反代后设 true，用 X-Forwarded-For 做限流键 |

## 消息协议（JSON 文本帧）

| 方向 | type | 负载 | 说明 |
|---|---|---|---|
| C→S | hello | – | 连接后首条，服务端回 config |
| S→C | config | iceServers, ttlMs | 下发 ICE（含 TURN 凭据） |
| C→S | create | – | 接收端建房 |
| S→C | created | code, expiresAt | 返回 6 位码 |
| C→S | join | code | 发送端加入 |
| S→C | joined / peer-join | peerId | 通知双方 |
| 双向透传 | offer / answer / candidate | sdp / candidate | 仅房间两端互转 |
| C→S | leave | – | 主动结束 |
| S→C | peer-left / expired / error | – | 对端离开/码过期/错误 |

单帧上限 256KB；非法 JSON、未知 type、频率异常都会被拒绝。日志只记录连接/建房/加入/过期事件。

## systemd（裸机替代 pm2）

```ini
# /etc/systemd/system/lts-signaling.service
[Unit]
Description=LTS Signaling
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/lts/server
ExecStart=/usr/bin/node signaling.mjs
Restart=always
User=nobody
EnvironmentFile=/opt/lts/server/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lts-signaling
```

## 反代要点

- 必须设置 `Upgrade`/`Connection: upgrade` 头（见 nginx-wss.example.conf / Caddyfile.example）。
- 长连接读写超时调到 ≥3600s，避免传输期间被反代断开（数据走 P2P/TURN，信令本身空闲也可能被掐）。
- 正式只暴露 wss（443），本机 8787 只绑 127.0.0.1。
