# 腾讯云轻量服务器部署指南

适用于当前项目：Go 单体服务、SQLite、本地静态资源。推荐架构：

```text
域名:18443 HTTPS → Caddy → 127.0.0.1:8889 → Go 服务 → assets/portfolio.db
```

一台腾讯云轻量应用服务器即可，不需要 Docker、云数据库或对象存储。

## 1. 购买服务器

建议购买 Ubuntu 22.04/24.04，1 核 2 GB、40 GB 磁盘即可。

腾讯云防火墙只开放：

- `22/TCP`：SSH
- `18443/TCP`：自定义 HTTPS 访问端口

不要开放 `8889`，Go 服务只监听本机。`18443` 是本方案选用的高位端口。

为域名添加 DNSPod A 记录：

```text
portfolio.example.com → 服务器公网 IP
```

## 2. 安装 Go

```bash
ssh ubuntu@你的服务器公网IP
sudo apt update
sudo apt install -y git curl build-essential ca-certificates
cd /tmp
curl -LO https://go.dev/dl/go1.25.0.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.25.0.linux-amd64.tar.gz
echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.profile
source ~/.profile
go version
```

## 3. 从 GitHub 部署项目

```bash
sudo useradd --system --home /opt/portfolio --shell /usr/sbin/nologin portfolio || true
sudo mkdir -p /opt/portfolio
sudo chown -R "$USER":"$USER" /opt/portfolio
```

公开仓库直接 clone：

```bash
git clone https://github.com/你的用户名/你的仓库名.git /opt/portfolio
cd /opt/portfolio
sudo chown -R portfolio:portfolio /opt/portfolio
```

私有仓库建议使用 SSH：

```bash
ssh-keygen -t ed25519 -C "tencent-cloud-deploy"
cat ~/.ssh/id_ed25519.pub
```

将输出的公钥添加到 GitHub：`Settings → SSH and GPG keys → New SSH key`，然后执行：

```bash
git clone git@github.com:你的用户名/你的仓库名.git /opt/portfolio
sudo chown -R portfolio:portfolio /opt/portfolio
```

不要把个人 SQLite 数据提交到公开 GitHub 仓库。建议在 `.gitignore` 中加入：

```gitignore
assets/portfolio.db
assets/portfolio.db-shm
assets/portfolio.db-wal
backups/
server.log
```

首次启动后，数据库会在服务器本地生成。如果需要恢复本地持仓，优先使用网站的“导入”功能；也可以在确认安全后单独复制数据库文件，并执行：

```bash
sudo chown portfolio:portfolio /opt/portfolio/assets/portfolio.db
sudo chmod 600 /opt/portfolio/assets/portfolio.db
```

## 4. 构建和测试

```bash
cd /opt/portfolio
go mod download
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o portfolio-server .
sudo chown portfolio:portfolio portfolio-server
```

手动检查：

```bash
sudo -u portfolio env PORTFOLIO_PORT=8889 /opt/portfolio/portfolio-server
```

另开 SSH 窗口执行：

```bash
curl -I http://127.0.0.1:8889/assets/index.html
```

返回 `200 OK` 后按 `Ctrl+C` 停止手动进程。

## 5. 配置 systemd

```bash
sudo nano /etc/systemd/system/portfolio.service
```

写入：

```ini
[Unit]
Description=Personal Portfolio Dashboard
After=network.target

[Service]
Type=simple
User=portfolio
Group=portfolio
WorkingDirectory=/opt/portfolio
Environment=PORTFOLIO_PORT=8889
ExecStart=/opt/portfolio/portfolio-server
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/portfolio/assets

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now portfolio
sudo systemctl status portfolio
sudo journalctl -u portfolio -f
```

## 6. 配置 Caddy 自定义 HTTPS 端口

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

编辑 `/etc/caddy/Caddyfile`：

```caddyfile
https://portfolio.example.com:18443 {
    reverse_proxy 127.0.0.1:8889
    encode gzip
}
```

替换真实域名后执行：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

访问 `https://portfolio.example.com:18443/assets/index.html`。

### 自定义端口的证书说明

如果服务器不开放 80/443，Caddy 可能无法使用默认 ACME 验证自动申请 Let's Encrypt 证书。推荐临时开放 80/443 完成证书申请，再关闭它们；证书之后仍可用于 `18443`。也可以配置 DNS-01 验证，但需要 DNSPod/Tencent Cloud DNS API 凭据，维护成本更高。

不要使用 `tls internal` 作为公网生产证书，否则普通浏览器会显示证书不受信任。

## 7. SQLite 备份

```bash
sudo install -d -o portfolio -g portfolio -m 700 /opt/portfolio/backups
sudo -u portfolio sqlite3 /opt/portfolio/assets/portfolio.db ".backup '/opt/portfolio/backups/portfolio-$(date +%F).db'"
sudo crontab -u portfolio -e
```

加入每日凌晨 3 点备份并删除 14 天前文件：

```cron
0 3 * * * /usr/bin/sqlite3 /opt/portfolio/assets/portfolio.db ".backup '/opt/portfolio/backups/portfolio-'\$(date +\%F)'.db'" && find /opt/portfolio/backups -type f -mtime +14 -delete
```

建议每周把 `backups/` 下载到本地或同步到腾讯云 COS。

## 8. 更新发布

```bash
cd /opt/portfolio
sudo -u portfolio sqlite3 assets/portfolio.db ".backup 'backups/pre-deploy-$(date +%F-%H%M).db'"
sudo systemctl stop portfolio
git pull
go mod download
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o portfolio-server .
sudo chown portfolio:portfolio portfolio-server
sudo systemctl start portfolio
sudo systemctl status portfolio
```

## 9. 上线检查

```bash
curl -I https://portfolio.example.com:18443/assets/index.html
curl -I https://portfolio.example.com:18443/assets/images/portfolio/wall-street-hero.jpg
```

浏览器确认首屏、两个轮盘、背景图、新增/编辑/删除、导入/导出、净值走势以及刷新后数据持久化。

## 常见问题

### 502 Bad Gateway

```bash
sudo systemctl status portfolio
curl -I http://127.0.0.1:8889/assets/index.html
sudo journalctl -u caddy -n 100 --no-pager
```

### HTTPS 证书失败

确认 DNS 已指向公网 IP，且腾讯云防火墙开放 `18443`。如果证书还未申请，临时开放 80/443 完成 ACME 验证。

### 数据重启后消失

确认 systemd 的 `WorkingDirectory=/opt/portfolio`，数据库为 `/opt/portfolio/assets/portfolio.db`。

### 图片 404

```bash
find /opt/portfolio/assets/images -type f | head
sudo chmod -R u=rwX,go=rX /opt/portfolio/assets/images
```

## 结论

当前项目最轻量的生产部署就是：腾讯云轻量应用服务器 + Go 二进制 + systemd + Caddy + SQLite 定时备份。只有需要多人账号、强隔离或高可用时，再升级到云数据库、容器和负载均衡。
