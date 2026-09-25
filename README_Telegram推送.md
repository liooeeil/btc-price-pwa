# Telegram 到价提醒

本功能由 Cloudflare Worker 在服务器端检查 OKX 行情。手机网页关闭后，Worker 仍按分钟检查启用的条件，并只在条件触发时通过 Telegram 发消息。页面里的提醒配置保存在 Cloudflare KV，不依赖手机继续运行。

## 一、创建 Telegram 机器人

1. 在 Telegram 搜索官方账号 @BotFather。
2. 发送 /newbot，按提示设置机器人名称和用户名。
3. 保存 BotFather 返回的 Bot Token。它等同密码，不要发给别人，也不要放进网页文件或 GitHub。
4. 打开新机器人对话，发送 /start。

## 二、部署 Cloudflare Worker

### 用 Cloudflare 网页控制台

1. 登录 Cloudflare，打开 Workers & Pages，创建一个 Worker。
2. 进入 Worker 的 Edit code，用 worker/worker-single.js 的全部内容替换示例代码，然后部署。
3. 在 Storage & Databases → KV 新建一个 KV namespace。
4. 回到 Worker 的 Settings → Bindings，新增 KV namespace binding：变量名填写 ALERT_KV，namespace 选刚创建的那个。
5. 在 Settings → Variables and Secrets 添加两个类型为 Secret 的值：
   - ADMIN_KEY：自己生成一段足够长的随机管理密钥。
   - TELEGRAM_BOT_TOKEN：BotFather 返回的令牌。
6. 在 Settings → Triggers → Cron Triggers 添加 * * * * *，让 Worker 每分钟检查一次。
7. 保存设置并重新部署。Worker 地址类似 https://tide-btc-alerts.<你的子域>.workers.dev。

### 用 Wrangler 命令行

本目录也含有 worker.js、alert-rules.js 和 wrangler.jsonc。创建 KV namespace 后，把 wrangler.jsonc 里的 REPLACE_WITH_YOUR_KV_NAMESPACE_ID 换成 Cloudflare 返回的 ID，然后在此目录登录并部署：

    npx wrangler login
    npx wrangler secret put ADMIN_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler deploy

命令会分别提示输入两个 Secret。不要把它们写入配置文件或提交到 GitHub。若 Worker 已经在网页控制台建立，Wrangler 部署前先确认登录的是同一个 Cloudflare 账户。

## 三、在 BTC 页面绑定并开启提醒

1. 在潮汐页面展开 价格提醒，打开想要启用的规则。
2. 填入 Worker 地址和 ADMIN_KEY，点击 保存并同步服务器策略。
3. 确认你已在 Telegram 对新机器人发送 /start。
4. 点击 绑定 Telegram 并发送测试。Worker 会绑定这个私聊并发一条测试消息。
5. 确认 Telegram 收到测试消息。之后只有规则触发时才会发行情提醒；不会定时推送价格。

服务器提醒最多检查观察列表中的前 8 个品种，以适配 Cloudflare Workers 免费计划的每次运行外部请求数限制。页面本地提醒仍按页面原有方式工作。

## 安全和故障排查

- GitHub Pages 只包含 Worker 地址和管理密钥输入框，不应包含 Bot Token。
- Worker 只允许来自 https://liooeeil.github.io 的浏览器跨域请求；管理操作还必须提供 X-Admin-Key。
- /api/health 可用于确认 Worker 已部署。它不会返回任何密钥。
- 页面显示跨域错误时，确认 Worker 对 GitHub Pages 域名启用了 CORS，并已部署最新代码。
- 点绑定时提示尚未收到 /start，回到机器人私聊发送 /start 后再试。
- 定时规则由 Cloudflare 按 UTC 调度，每分钟触发；实际提醒时间会有少量调度和行情接口延迟。
- Telegram 通知是否显示在锁屏，还取决于 iPhone/iPad 的 Telegram 通知权限和专注模式设置。
