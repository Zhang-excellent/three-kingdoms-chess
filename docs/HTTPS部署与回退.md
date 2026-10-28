# 公网 IP HTTPS 部署与回退

2026-10-28 对 `47.95.251.153` 的实测配置记录。证书、私钥、Certbot 账户和服务器原始配置只保留在服务器，不纳入 Git。本次没有更新三国象棋应用版本，也没有重启其 Node 服务。

## 实际站点与边界

- 80 端口的生效配置是 `/etc/nginx/sites-enabled/default`，其实际目标是 `/etc/nginx/sites-available/zhongchuliang`。静态首页位于 `/var/www/zhongchuliang`，`/api/` 代理到本机 8080。HTTPS 上的 `/newProject/`、`/newProject-api/` 来自 `/etc/nginx/snippets/grain-inspection-newProject.conf`，`/three-chess/` 与 Socket.IO 来自 `/etc/nginx/snippets/three-chess.conf`；HTTP 上这些路径现改为各自的 307 跳转片段。
- 443 端口新增 `/etc/nginx/sites-available/ip-https`，由 `/etc/nginx/sites-enabled/ip-https` 启用。它复用上述静态目录、接口规则及两个站点片段。参考配置见 [`../deploy/nginx-ip-https.conf`](../deploy/nginx-ip-https.conf)。与域名相关的独立虚拟主机需另行检查自己的证书与 `server_name`；直接访问其他端口的服务不会因这张 IP 证书自动获得 HTTPS。
- 三国象棋的 Node 服务继续监听 `127.0.0.1:3000`，Socket.IO 使用同源 `/three-chess/socket.io`；Nginx 片段保留 WebSocket Upgrade、`proxy_http_version 1.1` 和 `proxy_read_timeout 65s`。浏览器通过 HTTPS 打开页面时自动使用 WSS；没有改动应用代码或线上发布目录。
- 原首页脚本包含 `http://47.95.251.153:8080/api` 绝对地址，且实测 8080 没有监听，Nginx `/api/` 返回 502。首页静态页面与资源在 HTTPS 可打开，但相关接口不能算通过，暂不对该网站强制跳转。该问题需要对应网站的维护者单独修复。

## 证书与续期

服务器原先没有 Certbot 或证书。安装官方 Certbot snap 后版本为 5.8.0，满足 IP webroot 所需的 5.4 以上版本。80 端口的 `/etc/nginx/snippets/acme-ip.conf` 将 `/.well-known/acme-challenge/` 映射到 `/var/lib/letsencrypt/ip-webroot`；参考片段见 [`../deploy/nginx-acme-ip.conf`](../deploy/nginx-acme-ip.conf)。该路径必须保持 HTTP 可访问，不能被重定向覆盖。

正式证书使用下面的生产命令签发；没有使用 `--staging`、自签名证书或跳过证书验证的验收方式：

```sh
certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot \
  --webroot-path /var/lib/letsencrypt/ip-webroot \
  --ip-address 47.95.251.153 --cert-name 47.95.251.153
```

证书在 `/etc/letsencrypt/live/47.95.251.153/`，X.509 SAN 是 IP `47.95.251.153`。当前证书到期于 **2026-11-04 01:29:49 中国标准时间**（证书原值 `2026-11-03 17:29:49 UTC`）。IP 证书约六天有效，因此必须保持自动续期可用。

Certbot snap 安装的 `snap.certbot.renew.timer` 定期运行续期。部署 hook 安装在 `/etc/letsencrypt/renewal-hooks/deploy/three-chess-nginx-reload`，仅处理这张 IP 证书，先执行 `nginx -t`，成功后执行 `systemctl reload nginx`；参考脚本见 [`../deploy/certbot-renew-nginx.sh`](../deploy/certbot-renew-nginx.sh)。已执行 `certbot renew --dry-run --cert-name 47.95.251.153 --run-deploy-hooks`，模拟续期成功，hook 的配置检查也通过。日后可用以下命令复核：

```sh
certbot certificates --cert-name 47.95.251.153
systemctl list-timers --all | grep certbot
certbot renew --dry-run --cert-name 47.95.251.153 --run-deploy-hooks
nginx -t
```

## 验证与 HTTP 跳转

公网正常 TLS 校验下，`https://47.95.251.153/`、`/newProject/`、`/three-chess/` 的 HTML 及引用的静态资源均返回 200。`/newProject-api/` 在 HTTPS 返回 401（需要业务认证），HTTP 现返回 307 跳转；`/api/` 在两种协议下都返回 502，属于原有后端不可用。三国象棋健康接口和 Socket.IO 轮询均返回 200；另用三个独立 WSS 玩家连接和一个观战连接完成入房、准备、走棋同步、观战与玩家重连。浏览器实际打开 HTTPS 页面并确认“已连接联机服务器”。未进行实体手机或真人公网三人对局。

HTTP 和 HTTPS 是不同的浏览器来源，`localStorage` 中的棋局、房间重连凭证不会自动共享。切换前用户确认没有需要旧凭证重连的 HTTP 对局，服务器检查到三国象棋上游活动连接为 0；只看连接数本身不足以排除已断线房间。随后只对 `/three-chess/`、`/newProject/`、`/newProject-api/` 的 HTTP 路径启用 **307 临时跳转**，原首页不跳转，ACME 验证路径仍直接返回 200。首页的 API 问题修复前不强制跳转首页。HTTP 跳转片段参考 [`../deploy/nginx-three-chess-http-redirect.conf`](../deploy/nginx-three-chess-http-redirect.conf) 和 [`../deploy/nginx-newProject-http-redirect.conf`](../deploy/nginx-newProject-http-redirect.conf)。

当前 HTTP 站点文件 `/etc/nginx/sites-available/zhongchuliang` 包含 `/etc/nginx/snippets/three-chess-http-redirect.conf` 与 `/etc/nginx/snippets/newProject-http-redirect.conf`；443 站点继续包含原代理片段。公网实测 HTTP 游戏与新项目路径为 307，Location 指向对应 HTTPS 地址；HTTPS 健康接口与 Socket.IO 轮询仍为 200。`/api/` 继续保持原有 502，未被改写。

## 服务器备份与回退

服务器原始配置备份在 `/var/backups/three-chess/20261028-pre-https/`，包括原 HTTP 站点、站点软链接、两份原片段与 `nginx -T` 生效配置快照。每次改配置先运行 `nginx -t`，成功后再 reload。若要撤销 HTTPS 并保留当前应用版本，在服务器上执行：

```sh
BACKUP=/var/backups/three-chess/20261028-pre-https
SITE=$(cat "$BACKUP/site-default-path.txt")
cp -a "$BACKUP/site-default.original" "$SITE"
rm -f /etc/nginx/sites-enabled/ip-https
nginx -t && systemctl reload nginx
```

上述命令不触碰 `/opt/three-kingdoms-chess/current` 或三国象棋 Node 服务。证书和私钥可以留在服务器，避免误删其他服务可能正在引用的文件。若**仅撤销 HTTP 跳转，继续保留 HTTPS 与续期路径**，执行：

```sh
cp -a /var/backups/three-chess/20261028-pre-https/site-http-with-acme.pre-redirect /etc/nginx/sites-available/zhongchuliang
nginx -t && systemctl reload nginx
```

此操作无需关闭 443。证书续期失败时先看 `journalctl -u snap.certbot.renew.service` 和 `/var/log/letsencrypt/letsencrypt.log`，确认 80 端口的 ACME 路径仍返回 200；不要因首次签发成功就假定后续续期成功。

参考：[Let's Encrypt 的 Certbot IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)、[Certbot 自动续期与 hook 文档](https://eff-certbot.readthedocs.io/en/stable/using.html#automated-renewals)。
