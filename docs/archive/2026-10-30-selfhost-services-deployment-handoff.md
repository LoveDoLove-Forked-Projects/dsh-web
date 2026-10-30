# 自托管双服务部署交接清单

本文档为宝宝提供账号服务（Whale Account Service）与团队协作中枢（Team Hub Service）自托管架构在目标主机（43.153.135.11）上的生产部署交接清单与运维规范。账号服务实现细节参见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md，团队协作中枢实现细节参见 [team-hub/selfhost/README.md](../../team-hub/selfhost/README.md)。本文档聚焦跨服务拓扑协同、环境变量供给、首次上线执行次序、反向代理与进程保活配置及上线验收清单。

## 一、网络拓扑与端口监听约定

两个 Node.js 22 服务协同部署于单台 Ubuntu 目标宿主机，公网流量通过 nginx 统一接入并终止 TLS，内部 Node 进程仅监听本地回环。

| 属性 | 账号服务（Whale Account Service） | 团队协作中枢（Team Hub Service） |
|---|---|---|
| 主机名 / 域名 | `account.chatwithai.icu` | `hub.chatwithai.icu` |
| DNS 解析要求 | Cloudflare 灰云（DNS only），A 记录直接指向目标机 IP | Cloudflare 灰云（DNS only），A 记录直接指向目标机 IP |
| 目标机物理 IP | `43.153.135.11`（Ubuntu，已运行 nginx，Node 22.22） | `43.153.135.11`（Ubuntu，已运行 nginx，Node 22.22） |
| 进程监听地址 | `127.0.0.1`（回环接口，禁止绑定 `0.0.0.0`） | `127.0.0.1`（回环接口，禁止绑定 `0.0.0.0`） |
| 进程监听端口 | `8787`（通过环境变量 `PORT=8787` 指定） | `8788`（通过环境变量 `PORT=8788` 指定，覆盖代码默认的 8080） |
| TLS 终止层 | 宿主机 nginx（统一管理证书，HTTP/2 与 WebSocket 支持） | 宿主机 nginx（统一管理证书，HTTP/2 与 WebSocket 支持） |

两个服务的外部通信遵循既定契约：账号服务为认证源并签发短期断言，团队协作中枢校验该断言完成会话绑定。DNS 解析必须保持灰云直连，避免 CDN 代理层对 WebSocket 长连接及请求头的非预期篡改。

## 二、环境变量必需性与部署取舍矩阵

变量名与缺省行为的权威描述在两份 README，本文只记必需性与部署取舍。

| 服务 | 环境变量 | 必需性与部署取舍（细节链接） |
|---|---|---|
| 账号服务 | `DATABASE_PATH` | 必需（缺失即 exit 1）。SQLite 数据库绝对路径，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `APPLE_BUNDLE_ID` | 必需（缺失即 exit 1）。Apple identityToken 的 aud（App bundle id），见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `PORT` / `HOST` | 可选（缺省 8787 / 127.0.0.1）。反向代理前保持本地回环，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `BUILD_REV` | 可选（缺省 null）。用于 `/healthz` 回显构建版本，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `ACCOUNT_SERVICE_ORIGIN` | 可选（未配置退回请求 origin，非法值使断言端点 503）。生产环境固定设为 `https://account.chatwithai.icu`，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `ACCOUNT_ASSERTION_KEY_JWK` | 可选（缺失使 `/v1/keys` 与 `/v1/auth/assertion` 回 503）。ES256 私钥 JWK，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 可选（缺任一关闭 GitHub 登录，端点回 503）。不影响 Apple 登录，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `ADMIN_TOKEN` | 可选（缺失使 `/admin` 恒回 403）。管理端令牌（通过 `openssl rand -hex 32` 生成），见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `CONTACT_EMAIL` | 可选（缺失时法律页占位符保留原样）。运营联系邮箱，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `APPSTORE_IAP_KEY_ID` / `APPSTORE_ISSUER_ID` / `APPSTORE_PRIVATE_KEY` | 可选（缺任一使 `/v1/me` 自愈降级为不查远端）。App Store 凭据，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY_P8` | 可选（缺任一使 `/v1/push/relay` 与 `/v1/push/status` 回 503）。APNs 凭据，见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 账号服务 | `RELAY_TOKEN_SECRET` | 可选（缺失使 `/v1/push/devices` 与投递回 503）。HS256 密钥（通过 `openssl rand -hex 32` 生成），见 iphone_remote_use_dsh 仓库的 Server/selfhost/README.md（环境变量一节）。 |
| 团队协作中枢 | `DATABASE_PATH` | 必需（缺失即 exit 1）。SQLite 数据库绝对路径，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `TEAM_HUB_SESSION_KEY` | 必需（缺失即 exit 1）。会话 HMAC 签名密钥，缺失无法建会话，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `PORT` / `HOST` | 可选（缺省 8080 / 127.0.0.1）。生产环境必须显式配置 `PORT=8788`，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `BOOTSTRAP_TOKEN` | 可选（缺失使 `POST /api/v1/bootstrap` 回 503）。用于创建首个团队，首队建立后清空，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 可选（缺任一使 `/auth/github/*` 与 `/auth/token` 回 503）。团队专属 OAuth App，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `ACCOUNT_JWKS_URL` / `ACCOUNT_ISSUER` / `ACCOUNT_AUDIENCE` | 可选（缺任一使 `/auth/account` 与 `/auth/account/link` 回 503）。账号断言集成三元组：JWKS 地址固定配 `https://account.chatwithai.icu/v1/keys`，ISSUER 必须与账号服务 `ACCOUNT_SERVICE_ORIGIN` 逐字相同，AUDIENCE 固定设为 `dsh-team-hub`，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY_P8` | 可选（缺任一使推送端点回 503）。APNs 凭据，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |
| 团队协作中枢 | `MIGRATIONS_DIR` / `SWEEP_INTERVAL_MS` | 可选（缺省分别为相对路径与 60000ms）。迁移脚本目录与定时清理轮询间隔，见 [team-hub/selfhost/README.md#configuration](../../team-hub/selfhost/README.md#configuration)。 |

## 三、首次部署执行顺序与依赖拓扑

服务上线存在强拓扑约束：账号服务必须先生效，团队协作中枢的 `ACCOUNT_JWKS_URL`、`ACCOUNT_ISSUER` 与 `ACCOUNT_AUDIENCE` 配置才有校验实体与公钥来源。部署操作按以下六个阶段串行执行。

### 阶段 1：目录与权限初始化

1. 创建服务工作目录：`mkdir -p /srv/whale-account /srv/team-hub/selfhost /srv/team-hub/migrations`。
2. 创建数据存储目录与备份目录：`mkdir -p /var/lib/whale /var/lib/team-hub /var/backups/whale /var/backups/team-hub`。
3. 创建专用服务运行用户（如 `www-data` 或 `whale`），将数据与备份目录属主归一：`chown -R www-data:www-data /var/lib/whale /var/lib/team-hub /var/backups/whale /var/backups/team-hub && chmod 700 /var/lib/whale /var/lib/team-hub`。
4. 部署环境变量文件：将配置写入 `/etc/whale/account.env` 与 `/etc/whale/team-hub.env`，并锁定权限：`chmod 600 /etc/whale/*.env && chown www-data:www-data /etc/whale/*.env`。

### 阶段 2：安装依赖与构建

1. 部署账号服务代码至 `/srv/whale-account`，确认包含 `src/`、`docs/legal/` 与 `Server/migrations/`。
2. 在账号服务目录执行依赖安装：`cd /srv/whale-account && pnpm install`（确保 `pnpm-workspace.yaml` 放行 `better-sqlite3` 安装脚本编译原生绑定）。
3. 部署团队协作中枢代码至 `/srv/team-hub`，确认包含 `selfhost/`、`src/` 与 `migrations/`。
4. 在团队协作中枢目录执行依赖安装与构建：`cd /srv/team-hub/selfhost && pnpm install && pnpm build`（esbuild 编译产出 `dist/main.js`）。

### 阶段 3：执行数据库首次迁移

1. 账号服务执行迁移：`cd /srv/whale-account && node src/migrate.mjs`，验证终端输出 `0001`～`0004` 四个迁移文件全部应用。
2. 团队协作中枢迁移：中枢在启动时会自动比对并应用 `team-hub/migrations/`，亦可通过验证脚本确认迁移目录完整可用。

### 阶段 4：按序拉起进程（先账号，后 hub）

1. 启动账号服务：`systemctl enable --now whale-account.service`。
2. 验证账号服务本地存活与就绪：执行 `curl -s http://127.0.0.1:8787/healthz` 返回 `{"ok":true,...}`；执行 `curl -s http://127.0.0.1:8787/readyz` 返回 `{"ok":true,"db":"connected"}`。
3. 启动团队协作中枢服务：`systemctl enable --now team-hub.service`。
4. 验证中枢服务本地存活与就绪：执行 `curl -s http://127.0.0.1:8788/healthz` 返回 `{"status":"ok",...}`；执行 `curl -s http://127.0.0.1:8788/readyz` 返回 HTTP 200 且 `pending_migrations` 为 0。

### 阶段 5：验证跨服务公钥获取与断言链

1. 验证账号服务 JWKS 公钥公布：`curl -s http://127.0.0.1:8787/v1/keys`，确认包含带有 `kid` 标识的 P-256 公钥对象。
2. 验证 hub 能够成功解析账号服务 JWKS 地址并就绪。

### 阶段 6：放行与重载 nginx

1. 将下文 nginx 配置文件部署至 `/etc/nginx/sites-available/` 并建立软链至 `/etc/nginx/sites-enabled/`。
2. 执行配置自检：`nginx -t`。
3. 重载反向代理服务放行外网流量：`systemctl reload nginx`。

## 四、nginx 配置核心规范

nginx 承担 TLS 终结、请求限流透传与 WebSocket 双向协议升级职责。

```nginx
# 账号服务反向代理
server {
    listen 443 ssl http2;
    server_name account.chatwithai.icu;

    ssl_certificate /etc/letsencrypt/live/account.chatwithai.icu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/account.chatwithai.icu/privkey.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}

# 团队协作中枢反向代理
server {
    listen 443 ssl http2;
    server_name hub.chatwithai.icu;

    ssl_certificate /etc/letsencrypt/live/hub.chatwithai.icu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.chatwithai.icu/privkey.pem;

    client_max_body_size 10m;

    # 普通 HTTP API 路由
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # 团队实时通信 WebSocket 路由
    location /api/v1/teams/ {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 必须显式配置超长读写超时，防止长连接被 nginx 空闲切断
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

配置说明与关键约束：

1. **WebSocket 协议升级**：团队协同依赖长连接双向通信，`/api/v1/teams/` 路径必须显式包含 `Upgrade` 与 `Connection "upgrade"` 请求头，并将 `proxy_read_timeout` 设为 `86400s`。缺省 60 秒超时会导致客户端连接频繁中断重连。
2. **正文体积上限（client_max_body_size）**：账号服务内部限制请求体单包最大 256 KiB，中枢服务协议报文最大 128 KiB。nginx 配置 `10m` 保证大包在进入 Node 进程前不被反代层提前返回非格式化的 HTML 413 错误页，由应用进程返回符合标准信封规范的 JSON 错误。
3. **真实客户端 IP 透传（X-Forwarded-For）**：两个服务内部均依据 `X-Forwarded-For` 提取客户端真实公网 IP 作为限流器（Rate Limiter）的 Bucket 键。若未正确透传，账号服务退化为回环套接字地址 `127.0.0.1`，导致全网客户端共享单一限流额度频繁误报 429；中枢服务则退化记录为 `unknown`。
4. **原始协议透传（X-Forwarded-Proto）**：两个服务均基于 `X-Forwarded-Proto` 重建请求 URL 与校验 OAuth 回调 Origin。缺失时会导致 HTTPS 请求被误认为 HTTP，触发重定向死循环或 OAuth 握手失败。

## 五、systemd 守护进程与服务管理

两个服务采用独立 systemd 服务单元管理，实现开机自启、故障自动拉起、启动前自动数据库迁移与结构化日志沉淀。

### 1. 账号服务单元（/etc/systemd/system/whale-account.service）

```ini
[Unit]
Description=Whale Account Service (Node.js)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/srv/whale-account
EnvironmentFile=/etc/whale/account.env
ExecStartPre=/usr/bin/node /srv/whale-account/src/migrate.mjs
ExecStart=/usr/bin/node /srv/whale-account/src/index.mjs
Restart=always
RestartSec=3s
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 2. 团队协作中枢单元（/etc/systemd/system/team-hub.service）

```ini
[Unit]
Description=Whale Team Hub Service (Node.js)
After=network.target whale-account.service
Wants=whale-account.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/srv/team-hub/selfhost
EnvironmentFile=/etc/whale/team-hub.env
ExecStart=/usr/bin/node /srv/team-hub/selfhost/dist/main.js
Restart=always
RestartSec=3s
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

运维关键点：

1. **工作目录严格对齐**：账号服务 `WorkingDirectory` 必须设为包含 `docs/legal/` 的目录，否则动态读取法律文件抛出 404/500；中枢服务必须对齐以正确定位迁移目录。
2. **前置迁移执行**：账号服务配置 `ExecStartPre` 在每次拉起前执行 `node src/migrate.mjs`，确保库结构早于服务监听就绪。中枢在 `dist/main.js` 启动逻辑内已嵌入同等迁移能力。
3. **高可用重启策略**：配置 `Restart=always` 与 `RestartSec=3s`，异常崩溃或依赖抖动时系统自动恢复。
4. **日志采集与退出诊断**：标准输出与错误输出直通 systemd journal。非零退出码时可在目标机执行 `journalctl -u whale-account.service -n 50 --no-pager` 或 `journalctl -u team-hub.service -n 50 --no-pager` 逐行查看 JSON 格式的退出原因与缺失配置报错。

## 六、数据管理、WAL 特性与备份策略

两个服务均选用嵌入式 SQLite（better-sqlite3 驱动）作为数据持久化底座。

### 1. 数据文件路径与存储
- 账号服务数据库文件：`/var/lib/whale/account.db`。
- 协作中枢数据库文件：`/var/lib/team-hub/hub.sqlite`。
- 数据存储目录属主必须属于运行用户（`www-data:www-data`），权限配置为 `700`。

### 2. SQLite WAL 模式特性
- 两个服务均自动启用 WAL（Write-Ahead Logging）模式（`journal_mode=WAL`），设置 `synchronous=NORMAL` 与 `busy_timeout=5000`。
- 运行期间，数据库目录下会伴随生成 `<db-name>-wal`（写入日志）与 `<db-name>-shm`（共享内存索引文件）。
- 严禁在服务运行状态下移动、删除或篡改 `-wal` 和 `-shm` 文件，否则直接导致数据库损坏或未提交事务丢失。

### 3. 在线热备份规范（严禁直接 copy）
- **禁止操作**：严禁在进程运行期间直接使用系统命令 `cp`、`scp` 或 `rsync` 拷贝正在写入的 `.db` 主文件。直接拷贝会绕过 WAL 内存锁定，得到处于半写入或损坏状态的不可用副本。
- **规范备份命令**：必须使用 SQLite 内置的在线原子热备机制（`sqlite3 .backup` 或 `VACUUM INTO` 语句），备份任务可配置于 cron 定时执行：

```bash
# 账号服务在线热备份
/usr/bin/sqlite3 /var/lib/whale/account.db ".backup /var/backups/whale/account-$(date +\%Y\%m\%d\%H\%M\%S).db"

# 团队协作中枢在线热备份
/usr/bin/sqlite3 /var/lib/team-hub/hub.sqlite ".backup /var/backups/team-hub/hub-$(date +\%Y\%m\%d\%H\%M\%S).sqlite"
```

### 4. 迁移机制的幂等性与安全性
- 账号服务通过 `schema_migrations` 记录已执行的 SQL 脚本文件名；中枢服务通过 `d1_migrations` 记录已执行脚本。
- 每次启动时迁移器均按文件名升序比对差异，未执行的文件在独立事务中依次应用，已应用的脚本直接跳过。重复执行迁移命令或多次重启服务完全安全无副作用。

## 七、上线自检清单（逐条可勾）

部署完成后，在目标主机上按照以下清单逐条核对，每项均需获得明确证据：

- [ ] **healthz/readyz 通过**：调用账号服务探针 `curl -s http://127.0.0.1:8787/healthz` 返回 HTTP 200 且响应体为 `{"ok":true,...}`，调用 `curl -s http://127.0.0.1:8787/readyz` 返回 HTTP 200 且响应体为 `{"ok":true,"db":"connected"}`；调用中枢服务探针 `curl -s http://127.0.0.1:8788/healthz` 返回 HTTP 200 且响应体包含 `"status":"ok"` 与协议版本 `1.0.0`，调用 `curl -s http://127.0.0.1:8788/readyz` 返回 HTTP 200 且 `pending_migrations` 为 0。
- [ ] **迁移账本行数符合预期**：执行 `sqlite3 /var/lib/whale/account.db "SELECT count(*) FROM schema_migrations;"`，行数严格等于 4（完整覆盖 `0001`～`0004`）；执行 `sqlite3 /var/lib/team-hub/hub.sqlite "SELECT count(*) FROM d1_migrations;"`，行数严格等于 4（完整覆盖中枢 `0001`～`0004` 迁移）。
- [ ] **缺密钥时对应端点 503 而不是 500**：未配置 GitHub 凭据时，调用 `curl -s -X POST http://127.0.0.1:8787/v1/auth/github` 返回 HTTP 503 与 JSON `{"error":"not_configured"}`，调用 `curl -s http://127.0.0.1:8788/auth/github/authorize` 返回 HTTP 503 与 JSON `{"ok":false,"error":{"code":"NOT_CONFIGURED"}}`；账号服务未配置断言私钥时，调用 `curl -s http://127.0.0.1:8787/v1/keys` 返回 HTTP 503，无未捕获异常抛出。
- [ ] **WebSocket 用 Authorization 头能连上且 since_seq 能补发**：客户端发起 `GET /api/v1/teams/<teamId>/ws?protocol_version=1.0.0` 并携带 `Authorization: Bearer <token>` 能够成功建立 WebSocket 连接（Query 中携带 Token 被立即拒绝）；携带旧 `since_seq` 重连时，若序号在重放缓冲区范围内则正确补发事件，若超出缓冲区或服务重启序号重置，服务端正确下发 `resync_required` 信令通知客户端拉取全量快照。
- [ ] **nginx 透传后限流键不是 unknown**：从外部发起高频请求触碰限流阀值，验证返回 HTTP 429 `rate_limited`；检查账号服务数据库 `rate_limits` 表或日志，确认记录的 IP 键为真实的客户端公网 IP 而非回环地址 `127.0.0.1`；检查中枢服务日志，确认无因缺少 `X-Forwarded-For` 导致将限流键标记为 `unknown` 的告警。

## 八、与 Cloudflare 版的取舍

自托管实现针对私有运行环境进行了可控的技术取舍，部署与排障时需知晓以下机制差异：

1. **监控采集与定时清理**：自托管没有 Cloudflare 平台的采集与 cron，全部转为进程内 `setInterval` 驱动（账号服务每 10 分钟自动执行一次 SQL 清理过期 `rate_limits` 记录；团队协作中枢以 `SWEEP_INTERVAL_MS` 默认每 60 秒轮询清理离线主机心跳、失效租约与超时卡片），标准日志写入 stdout/stderr 并由 systemd journal 聚合记录。
2. **WebSocket 频道状态与序列号自愈**：自托管中枢没有 Cloudflare Durable Object，频道事件序列号（sequence counter）、增量重放缓冲区（replay buffer）与 WebSocket 活跃连接全量维护在 Node.js 进程内存中；进程重启后序列号重置为 0，客户端携带重启前的旧 `since_seq` 重连时收到服务端下发的 `resync_required` 指令，随后主动发起全量快照拉取完成状态同步，走协议既有的自愈路径。
3. **法律条款静态文件依赖**：Cloudflare 版在构建打包阶段将法律正文编译进 bundle，自托管账号服务在首次收到 `/legal/privacy` 与 `/legal/terms` 请求时直接读取宿主机磁盘上的 `docs/legal/*.md` 并缓存至内存，部署产物必须完整带上这些 Markdown 文件，否则法律条款访问端点将返回 404 文件未找到。
