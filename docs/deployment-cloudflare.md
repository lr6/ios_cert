# Cloudflare Pages 部署说明

本工具是**纯静态站点**：没有后端、没有数据库、没有服务端进程，也不需要任何 Cloudflare Workers 逻辑。
Cloudflare Pages 只负责托管 `dist/` 里的静态文件。

## 1. 构建参数

| 项目 | 值 |
| --- | --- |
| 构建命令 | `npm run build` |
| 输出目录 | `dist` |
| Node.js 版本 | `20.19` 或更高（Pages 可在设置里指定 `NODE_VERSION=20.19.0`） |
| 环境变量 | **不需要任何环境变量**（不要在这里放密钥、证书或密码） |

## 2. 第一次部署（GitHub 连接 + 自动部署）

1. 把项目推送到 GitHub：

   ```bash
   git init
   git add .
   git commit -m "feat: iOS certificate manager"
   git branch -M main
   git remote add origin https://github.com/<你的账号>/<仓库名>.git
   git push -u origin main
   ```

2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**；
3. 选择刚推送的仓库，授权 Cloudflare 读取该仓库；
4. 填写构建配置：
   - **Framework preset**：`Vue`（或 `None`）
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
   - **Environment variables**：留空（如需固定 Node 版本，可加 `NODE_VERSION = 20.19.0`）
5. 点击 **Save and Deploy**，等待构建完成；
6. 之后每次 push 到 `main` 都会自动重新构建部署；Pull Request 会生成预览环境。

## 3. 命令行部署（可选，使用 Wrangler）

```bash
npm run build
npx wrangler pages deploy dist --project-name ios-certificate-manager
```

首次执行会要求登录 Cloudflare 账号并创建项目。

## 4. SPA 路由回退

`public/_redirects` 内容为：

```
/*    /index.html   200
```

它会被复制到 `dist/_redirects`，Cloudflare Pages 据此把所有未命中的路径交给 `index.html`，
因此直接访问或刷新 `/certificates/<id>`、`/settings` 都不会 404。

> 也可以使用 Cloudflare Pages 的 "Single Page Application" 兼容设置（自动回退）作为等效方案，但本项目的 `_redirects` 已显式声明，无需额外配置。

## 5. 安全响应头（CSP）

`public/_headers` 会在构建后输出为 `dist/_headers`，Cloudflare Pages 会自动应用：

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ... 
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: ...
```

说明：

- `script-src 'self'` 意味着**加载任何第三方脚本都会被浏览器拦截**，这正是我们想要的（页面会在本地接触私钥）；
- 仅 `style-src` 允许 `'unsafe-inline'`，因为 Element Plus / Vue 会写入内联样式；
- 没有 `connect-src` 之外的放行项，站点不会向任何外部域发起请求。

本地验证响应头与回退行为（推荐在部署前跑一次）：

```bash
npm run build
node scripts/serve-dist.mjs 4174
# 然后访问 http://localhost:4174/certificates 与 http://localhost:4174/certificates/<任意id>
```

## 6. 自定义域名（可选）

Pages 项目 → **Custom domains** → 添加你的域名并按提示配置 DNS。若使用 Cloudflare 托管的 DNS，通常会自动创建 CNAME。

## 7. 部署后的安全检查清单

- [ ] 站点通过 HTTPS 访问（Pages 默认提供）；
- [ ] 浏览器控制台没有 CSP 违规报错；
- [ ] 页面**不发起任何跨域请求**（DevTools → Network 过滤 `Domain` 列）；
- [ ] `dist/` 中没有私钥、证书、P12 或测试密码（运行 `npm run check:dist`）；
- [ ] 仓库中**没有**提交任何真实私钥、P12、备份文件（`.gitignore` 已排除 `dist/`、`node_modules/` 等）；
- [ ] 若使用自定义域名，确认没有额外的第三方分析/统计脚本（会破坏 CSP，也会引入私钥泄露风险）。

## 8. 部署后仍存在的风险（务必知晓）

即使部署正确，**页面本身仍是在浏览器里接触私钥的**：

- 若你的域名/Deploy 权限被他人接管，攻击者可以发布会窃取私钥的新版本；
- 若浏览器安装了恶意扩展，它可以读取页面内存与 IndexedDB；
- 因此建议：只在个人设备使用、为 Cloudflare/GitHub 账号开启两步验证、不要随意授权协作者。

详见 [security.md](security.md)。
