# 潮汐 · BTC 行情 PWA

这是从原 `价格提醒.html` 制作的静态部署包。行情图表、OKX 合约搜索、K线、MA/EMA/SMMA、图形绘制、本地提醒和 `localStorage` 设置仍由原页面代码提供。HTML 已改名为 `index.html`，提醒规则脚本和运行脚本也一并放入本目录。

## 文件

- `index.html`：应用入口
- `manifest.webmanifest`：主屏幕名称、图标、独立窗口模式和相对路径配置
- `sw.js`：缓存应用外壳；断网时可重新打开已缓存的页面，但行情和外部图表库仍需联网
- `alert-rules.js`、`alert-runtime.js`：原提醒逻辑
- `icon-*.png`：主屏幕图标和 PWA 图标

## Windows 上用 GitHub Pages 免费部署

1. 在 GitHub 新建一个公开仓库，例如 `btc-price-pwa`。
2. 解压此文件夹，把里面所有文件和 `icons` 文件夹上传到仓库根目录（确保 `index.html` 在根目录）。
3. 在仓库打开 **Settings → Pages**，在 **Build and deployment** 选择 **Deploy from a branch**，分支选 `main`、目录选 `/ (root)`，保存。
4. 等待 Pages 发布后，用 iPhone/iPad 的 Safari 打开 GitHub Pages 给出的 `https://…github.io/…/` 地址。
5. 轻点 Safari 的分享按钮，选 **添加到主屏幕**，确认名称为“潮汐 BTC”，然后从主屏幕图标启动。

更新时在 Windows 替换仓库中的文件并提交即可。GitHub Pages 和 Cloudflare Pages 都提供 HTTPS；请从发布后的 HTTPS 地址安装，不要尝试在 iPhone 上打开本地 HTML 文件。

## Cloudflare Pages 备选

在 Cloudflare 控制台打开 Workers & Pages，选择创建应用 → Get started → Drag and drop your files，把 `btc-price-pwa.zip` 上传并部署。后续更新可在项目中创建新部署并重新上传 ZIP。Cloudflare 的 Direct Upload 项目不能之后切换成 Git 集成；如果想让每次提交自动发布，请一开始就选 Git 集成。发布后用 HTTPS 地址在 Safari 添加到主屏幕。

## 行情、CORS 与 CSP

- 页面从浏览器直接请求 `https://www.okx.com/api/v5/market/...` 的公开行情与合约目录接口；不使用 OKX API 密钥。OKX 文档将 Market Data 列为无需认证的接口。浏览器跨域调用最终仍受 OKX 响应头和网络/地区可达性控制；若连接失败，页面会显示行情加载失败，不代表静态部署失败。
- `lightweight-charts` 5.0.8 从 `unpkg.com` 加载，字体从 Google Fonts 加载。图表库和行情都需要联网；字体加载失败会回退到系统字体。
- 本包不附加 CSP 响应头：页面包含原有内联脚本/样式，且可选的提醒同步功能允许填写自己的 Worker 地址。若你在托管平台或代理上主动设置 CSP，至少需要允许 `script-src` 的 `'unsafe-inline'` 与 `https://unpkg.com`，`style-src` 的 `'unsafe-inline'` 与 `https://fonts.googleapis.com`，`font-src` 的 `https://fonts.gstatic.com`，以及 `connect-src` 的 `'self'`、`https://www.okx.com` 和你实际使用的 Worker 域名。CSP 中未允许对应源时，浏览器会拦截请求。

## 使用边界

主屏幕 Web App 与独立 iOS App 不同。页面打开时的提醒可在前台运行；iOS 挂起网页后，不能依赖它持续后台轮询或保证系统推送。要实现 App 关闭后可靠提醒，需要服务器监控和推送服务。

- 当前原页面固定使用 https://www.okx.com。OKX 官方文档提示部分地区注册账户需要使用地区 API 域名；若你的账户属于美国/澳大利亚或欧洲经济区，需按 OKX 当前文档调整行情域名。
