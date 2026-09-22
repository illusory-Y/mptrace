# Coturn STUN/TURN 部署说明

自动选路顺序：**同局域网直连 → STUN 公网打洞直连 → TURN 中转兜底**。
大多数家庭宽带/4G5G 下 STUN 即可直连；只有双方都处在对称 NAT（部分公司网络、校园网、部分运营商 CGN）时才会走 TURN。TURN 只转发加密后的数据包，**无法看到文件内容，也不存储文件**。

## 一、系统包安装（Debian / Ubuntu）

```bash
sudo apt update && sudo apt install -y coturn
# 1. 编辑配置
sudo cp turnserver.conf /etc/turnserver.conf
sudo nano /etc/turnserver.conf       # 修改 external-ip、user、realm、证书路径
# 2. 允许开机自启（Debian 包默认关闭）
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl restart coturn
sudo systemctl enable coturn
sudo systemctl status coturn
```

## 二、Docker 部署

```bash
# 修改本目录 turnserver.conf 后
docker compose up -d
docker logs -f lts-coturn
```

> TURN 依赖 host 网络（`network_mode: host`），请直接在 **Linux VPS** 上用该 compose；
> Windows/macOS 的 Docker Desktop 对 host 网络支持不完整，桌面环境请用「系统包安装」方式。

## 三、防火墙 / 云安全组放行

| 端口 | 协议 | 用途 |
|---|---|---|
| 3478 | TCP + UDP | STUN/TURN 基础监听 |
| 5349 | TCP + UDP | TURNS（TLS） |
| 49152-65535 | UDP | 中继数据端口范围 |

云主机还要在**云厂商控制台的安全组**里放行上述端口（主机 ufw/iptables 与安全组是两层）。

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
```

## 四、TLS 证书（turns 推荐）

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d turn.example.com
# 证书路径与 turnserver.conf 中 cert/pkey 对应；certbot 续期后重启 coturn：
echo '0 4 * * * root systemctl restart coturn' | sudo tee /etc/cron.d/coturn-reload
```

## 五、连通性验证

打开 Trickle ICE 测试页：<https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>

1. STUN 填 `stun:turn.example.com:3478`，点 Gather candidates，能看到 `srflx` 类型候选即 STUN 正常。
2. TURN 填 `turn:turn.example.com:3478`，用户名/密码填配置里的 `lts_friend` 与密钥，能看到 `relay` 候选即 TURN 正常。
3. App 内连接后，互传页徽标会显示实际路径：「局域网直连 / 公网穿透直连 / TURN 服务器中转」。

## 六、与信令服务对接

把同套凭据填入 `server/.env`：

```ini
TURN_URL=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349
TURN_USERNAME=lts_friend
TURN_CREDENTIAL=change-me-to-a-long-random-secret
```

重启信令服务后，客户端建立连接时会自动收到该配置，用户无需手动填写。

## 七、运维与成本提示

- TURN 中转流量 ≈ 文件大小（收+发各一份时约 2 倍），朋友小范围使用带宽成本极低；VPS 选按流量计费即可。
- 想进一步收敛，可在配置里用 `allowed-peer-ip` 只放行你们自己的出口 IP。
- 日志只含连接事件，建议配置 logrotate，不做长期留存。
