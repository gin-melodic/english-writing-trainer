# ECS 部署手册（Ubuntu 22.04 64 位）

适用项目：`english-writing-trainer`。这是一个 Next.js 应用，生产运行依赖 `npm run build` + `npm run start`，本地数据写入 `data/trainer.db`，LLM 配置在页面 Settings 中保存到 SQLite。

## 1. ECS 基础准备

建议规格：

- Ubuntu 22.04 64 位
- 至少 2 vCPU / 4 GiB RAM
- 安全组开放：`22/tcp`、`80/tcp`、`443/tcp`
- 应用内部端口：`3000/tcp`，只给本机 Nginx 反代，不建议安全组直接暴露

登录：

```bash
ssh root@<ECS_PUBLIC_IP>
```

系统包：

```bash
apt update
apt install -y git curl ca-certificates nginx sqlite3 ufw
```

Node.js 建议用 Node 22 LTS：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
npm -v
```

创建部署用户：

```bash
adduser app
usermod -aG sudo app
```

后续建议切到 `app` 用户操作代码：

```bash
su - app
```

## 2. 拉代码与安装依赖

```bash
mkdir -p ~/apps
cd ~/apps
git clone <REPO_URL> english-writing-trainer
cd english-writing-trainer
npm ci
```

确认仓库里没有把本机数据库误提交上去。生产库路径固定是：

```text
data/trainer.db
```

如果需要从旧机器迁移，先停服务，再复制整个 `data/` 目录或至少复制：

```text
data/trainer.db
data/trainer.db-wal
data/trainer.db-shm
```

## 3. 构建与本机验证

```bash
npm run test
npm run build
```

临时试跑：

```bash
PORT=3000 HOSTNAME=127.0.0.1 npm run start
```

另开一个 SSH 窗口检查：

```bash
curl -I http://127.0.0.1:3000
```

确认后停止临时进程。

## 4. systemd 服务

用 root 写服务文件：

```bash
sudo tee /etc/systemd/system/english-writing-trainer.service >/dev/null <<'EOF'
[Unit]
Description=English Writing Trainer
After=network.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/home/gin/english-writing-trainer
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
Environment=PATH=/home/gin/.nvm/versions/node/v22.17.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/gin/.nvm/versions/node/v22.17.1/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now english-writing-trainer
sudo systemctl status english-writing-trainer
```

日志：

```bash
sudo journalctl -u english-writing-trainer -f
```

## 5. Nginx 反向代理

创建站点：

```bash
sudo tee /etc/nginx/sites-available/english-writing-trainer >/dev/null <<'EOF'
server {
    listen 80;
    server_name <DOMAIN_OR_ECS_PUBLIC_IP>;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/english-writing-trainer /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

访问：

```text
http://<DOMAIN_OR_ECS_PUBLIC_IP>
```

## 6. HTTPS（可选但建议）

域名解析到 ECS 后：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <DOMAIN>
```

检查自动续期：

```bash
sudo systemctl status certbot.timer
```

## 7. GLM-4.7-Flash 接口

API Key 从 `.env` 读取；模型地址和模型名在网页 Settings 中保存到 SQLite。

`.env` 中填写：

```bash
ZAI_API_KEY=your-api-key
```

Settings 中填写：

- GLM API URL：`https://open.bigmodel.cn/api/paas/v4`
- 模型名：`glm-4.7-flash`
- 应用并发生成数：固定为 `1`，匹配免费模型并发限制

连接测试通过后再开始测评/练习。

## 8. 数据备份

SQLite 使用 WAL 模式，备份建议用 `sqlite3 .backup`，不要只复制主库文件。

```bash
mkdir -p ~/backups
sqlite3 /home/app/apps/english-writing-trainer/data/trainer.db ".backup '/home/app/backups/trainer-$(date +%F-%H%M%S).db'"
```

定时备份示例：

```bash
crontab -e
```

加入：

```cron
30 2 * * * sqlite3 /home/app/apps/english-writing-trainer/data/trainer.db ".backup '/home/app/backups/trainer-$(date +\%F-\%H\%M\%S).db'"
```

恢复：

```bash
sudo systemctl stop english-writing-trainer
cp /home/app/backups/<backup>.db /home/app/apps/english-writing-trainer/data/trainer.db
chown app:app /home/app/apps/english-writing-trainer/data/trainer.db
sudo systemctl start english-writing-trainer
```

## 9. 发布更新

```bash
cd /home/app/apps/english-writing-trainer
git pull --ff-only
npm ci
npm run test
npm run build
sudo systemctl restart english-writing-trainer
sudo systemctl status english-writing-trainer
```

如果 `npm ci` 更新了依赖，保留 `package-lock.json` 与代码版本一致。

## 10. 常用排障

服务状态：

```bash
sudo systemctl status english-writing-trainer
sudo journalctl -u english-writing-trainer -n 100 --no-pager
```

端口：

```bash
ss -lntp | grep -E ':80|:3000|:1234'
```

Nginx：

```bash
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
```

SQLite：

```bash
sqlite3 /home/app/apps/english-writing-trainer/data/trainer.db ".tables"
```

权限：

```bash
sudo chown -R app:app /home/app/apps/english-writing-trainer
```

如果页面能打开但 AI 功能失败，优先查：

- Settings 里的 GLM API URL 是否从 ECS 能访问
- `.env` 中 `ZAI_API_KEY` 是否有效，修改后是否重启服务
- 模型名是否为 `glm-4.7-flash`
- `journalctl` 中是否有 JSON 解析或网络超时错误

## 11. 最小上线检查表

- `npm ci` 成功
- `sqlite3` 已安装
- `npm run test` 通过
- `npm run build` 通过
- systemd 服务监听 `127.0.0.1:3000`
- Nginx `80/443` 正常反代
- `data/trainer.db` 所属用户是 `app`
- Settings 连接测试通过
- 已配置 SQLite 备份
