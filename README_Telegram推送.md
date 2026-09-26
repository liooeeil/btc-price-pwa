# Telegram + Bark 服务器提醒

本功能由 Cloudflare Worker 在服务器端检查 OKX 行情。手机网页关闭后，Worker 仍按提醒周期检查已明确配置的合约。条件触发时会并行尝试发送 Telegram 和 Bark 通知；任一渠道失败不会阻止另一渠道。每个合约单独保存策略；单纯加入自选不会启用提醒。页面里的提醒配置保存在 Cloudflare KV，不依赖手机继续运行。

## 一、创建 Telegram 机器人

1. 在 Telegram 搜索官方账号 @BotFather。
2. 发送 /newbot，按提示设置机器人名称和用户名。
3. 保存 BotFather 返回的 Bot Token。它等同密码，不要发给别人，也不要放进网页文件或 GitHub。
4. 打开新机器人对话，发送 /start。

## 二、部署 Cloudflare Worker

### 用 Cloudflare 网页控制台

1. 登录 Cloudflare，打开 Workers & Pages，创建一个 Worker。
2. 进入 Worker 的 Edit code，用本目录 `telegram-worker.js` 的全部内容替换示例代码，然后部署。
3. 在 Storage & Databases → KV 新建一个 KV namespace。
4. 回到 Worker 的 Settings → Bindings，新增 KV namespace binding：变量名填写 ALERT_KV，namespace 选刚创建的那个。
5. 在 Settings → Variables and Secrets 添加以下 Secret（`BARK_KEY` 已配置时无需重复设置）：
   - ADMIN_KEY：自己生成一段足够长的随机管理密钥。
   - TELEGRAM_BOT_TOKEN：BotFather 返回的令牌。
   - BARK_KEY：Bark App 中设备对应的 Key。
6. 在 Settings → Triggers → Cron Triggers 添加两条 UTC 定时规则：`59 3,5,7,11,15,17,19,23 * * *` 和 `2 0,4,6,8,12,16,18,20 * * *`。它们对应北京时间每个 4 小时收盘前 1 分钟和收盘后 2 分钟；启用 6 小时分型时，也覆盖 6 小时收盘点（额外如 01:59/02:02、13:59/14:02）。
7. 保存设置并重新部署。Worker 地址类似 https://tide-btc-alerts.<你的子域>.workers.dev。

### 用 Wrangler 命令行

如需用 Wrangler 部署，请使用主发布包中的 `worker/` 目录（含 `worker.js`、`alert-rules.js` 和 `wrangler.jsonc`）。先创建 KV namespace，并把 `wrangler.jsonc` 里的 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 换成 Cloudflare 返回的 ID，再在该目录运行：

    npx wrangler login
    npx wrangler secret put ADMIN_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put BARK_KEY
    npx wrangler deploy

命令会分别提示输入 Secret；已配置的 `BARK_KEY` 不需要重复设置。不要把任何 Secret 写入配置文件或提交到 GitHub。若 Worker 已经在网页控制台建立，Wrangler 部署前先确认登录的是同一个 Cloudflare 账户。

## 三、在 BTC 页面绑定并开启提醒

1. 在潮汐页面展开 价格提醒，打开想要启用的规则。
2. 填入 Worker 地址和 ADMIN_KEY，点击 保存并同步服务器策略。
3. 确认你已在 Telegram 对新机器人发送 /start。
4. 点击 绑定 Telegram 并发送测试。Worker 会绑定这个私聊并发一条测试消息。
5. 查看 Bark 状态；确认显示“已配置”后，点击 发送 Bark 测试，并确认 iPhone/iPad 收到通知。之后只有规则触发时才会发行情提醒；不会定时推送价格。

全部策略关闭时，Worker 会在读取 KV 配置后立即返回，不请求行情；任一策略开启时，仅检查明确启用提醒的合约，不会因为加入自选而监控该合约。常规策略在每个 4 小时收盘前约 1 分钟、收盘后约 2 分钟检查；启用 6 小时分型后，还会在额外的 6 小时收盘点各检查一次。最多支持 8 个已配置提醒的合约。网页保持打开时，本地提醒也只检查当前选择的合约，并按对应收盘时间检查。

## 安全和故障排查

- GitHub Pages 只包含 Worker 地址和管理密钥输入框，不应包含 Bot Token。
- Worker 只允许来自 https://liooeeil.github.io 的浏览器跨域请求；管理操作还必须提供 X-Admin-Key。
- `/api/health` 可用于确认 Worker 已部署，并查看 Telegram、Bark 是否已配置；不会返回任何密钥。
- Bark 测试接口为 `POST /api/bark/test`，必须提供 `X-Admin-Key`。
- 页面显示跨域错误时，确认 Worker 对 GitHub Pages 域名启用了 CORS，并已部署最新代码。
- 点绑定时提示尚未收到 /start，回到机器人私聊发送 /start 后再试。
- 定时规则由 Cloudflare 按 UTC 调度，换算为北京时间；实际提醒时间会有少量调度和行情接口延迟。
- Telegram 和 Bark 通知是否显示在锁屏，还取决于 iPhone/iPad 对应 App 的通知权限、Bark 的专注模式/时效性通知设置。

