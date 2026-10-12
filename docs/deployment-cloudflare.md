# Cloudflare 部署说明

本工具是**纯静态站点**：没有后端、没有数据库，也不需要任何服务端逻辑。

Cloudflare 现在有两套可托管静态站点的形态，本项目两种都能跑，下面分别说明（**你当前用的是第 1 种**）：

| 形态 | 说明 |
| --- | --- |
| **1. Workers（静态资源）** | 当前实际使用的形态：Worker 名 `ios-cert`，构建 `npm run build`，部署 `npx wrangler deploy` |
| **2. Pages** | 经典静态托管，同样可用（见本文第 5 节） |

---

## 1. 仓库内的部署配置（Workers）

仓库根目录的 `wrangler.jsonc`：

```jsonc
{
  "name": "ios-cert",
  "compatibility_date": "2026-05-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

三个要点：

1. **`assets.directory` 必须指向构建输出目录**（Vite 的 `dist`）。
2. **SPA 回退必须用 `not_found_handling`**。Workers 静态资源**不支持** `_redirects` 里写 `/*  /index.html  200` —— 服务端校验会判定为无限循环，直接让部署失败：
   ```
   Invalid _redirects configuration:
   Line 1: Infinite loop detected in this rule. [code: 100324]
   ```
   （Pages 允许这条规则，Workers 不允许；本项目原先就是踩了这个坑，所以改用 `not_found_handling`。）
3. **`compatibility_date` 不要写"今天"**。本地 `wrangler dev` 的 workerd 二进制未必支持当天日期，会报
   `This Worker requires compatibility date "..." but the newest date supported by this server binary is "..."`。
   纯静态资源 Worker 不受兼容性日期影响，填一个已稳定发布的日期即可。

`public/_headers` 会被复制到 `dist/_headers`，Workers 静态资源原生支持它（`wrangler dev` 会打印 `Parsed 2 valid header rules`），CSP 与其它安全响应头照常生效。

## 2. Workers 项目设置（Dashboard）

**Workers & Pages → 选择 `ios-cert` → Settings → Build**：

| 配置项 | 值 |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Deploy command | `npx wrangler deploy` |
| Environment variables | **留空**（不要在这里放密钥、证书或密码） |
| Node 版本 | 构建机上为 `nodejs@24`，项目要求 ≥ 20.19 |

连好 GitHub 后，每次 push 到 `main` 会自动构建并部署；Pull Request 会生成预览。

## 3. 本地验证（部署前强烈建议跑一遍）

```bash
# 1) 构建产物 + 敏感内容检查
npm run verify:all

# 2) 用真实的 Workers 运行时（workerd）验证配置、SPA 回退与响应头
npx wrangler dev --port 8788 --ip 127.0.0.1

# 3) 另开一个终端，检查深链是否都返回 index.html（应为 200）
curl -i http://127.0.0.1:8788/certificates
curl -i http://127.0.0.1:8788/certificates/any-id
curl -i http://127.0.0.1:8788/settings
```

预期：以上路径全部 `200`，`Content-Type: text/html`，响应体是 `index.html`；`wrangler dev` 日志中会看到
``Sec-Fetch-Mode: navigate` header present - using `not_found_handling` behavior``。

只校验配置与资源清单、不上传（不需要登录）：

```bash
npx wrangler deploy --dry-run
# ✨ Read N files from the assets directory .../dist
```

## 4. 命令行部署（可选）

```bash
npm run build
npx wrangler deploy
```

需要 `wrangler login`（或提供 `CLOUDFLARE_API_TOKEN`，仅放在你自己的终端环境里，**不要**写进仓库）。

## 5. 备选方案：改用 Cloudflare Pages

如果想用经典 Pages：

1. **Workers & Pages → Create → Pages → Connect to Git**，选择同一仓库；
2. 构建配置：Build command `npm run build`、Build output directory `dist`、环境变量留空；
3. SPA 回退：Pages 支持两种方式 —— 显式写 `public/_redirects`（`/*  /index.html  200`），或在 Pages 项目设置里开启 SPA 兼容回退。

> 注意：`_redirects` 的这条规则只在 **Pages** 上合法。若切回 Workers，必须删掉它并改用 `not_found_handling`，否则部署会因 100324 失败。

## 6. 自定义域名（可选）

Workers/Pages 项目 → **Settings → Domains & Routes** 添加自定义域名，按提示配置 DNS（Cloudflare 托管 DNS 时会自动建 CNAME）。

## 7. 部署后的安全检查清单

- [ ] 站点通过 HTTPS 访问；
- [ ] 浏览器控制台没有 CSP 违规报错（`script-src 'self'` 会拦掉任何第三方脚本）；
- [ ] 页面**不发起任何跨域请求**（DevTools → Network，按 Domain 排序确认）；
- [ ] 直接访问并刷新 `/certificates/<任意 id>` 不 404；
- [ ] `npm run check:dist` 通过（产物中没有私钥、证书、P12、测试密码）；
- [ ] 仓库中没有提交任何真实私钥、P12 或备份文件（`.gitignore` 已兜底）；
- [ ] Cloudflare 与 GitHub 账号都开启两步验证，不随意添加协作者。

## 8. 仍然存在的风险（务必知晓）

页面本身是在浏览器里接触私钥的：**如果域名 / 部署权限被他人接管，攻击者可以发布会窃取私钥的新版本**；浏览器恶意扩展同样可以读取页面内存与 IndexedDB。建议只在个人设备使用，详见 [security.md](security.md)。

---

## 附：一次真实的部署故障记录（2026-10-12）

| 现象 | 构建全部成功（`✓ built in 11.58s`），但最后一步失败：`A request to the Cloudflare API ... failed. Invalid _redirects configuration: Line 1: Infinite loop detected in this rule. [code: 100324]` |
| --- | --- |
| 原因 | `public/_redirects` 里写的是 Pages 风格的 SPA 回退规则 `/*  /index.html  200`，Workers 静态资源的校验器认为它会在"剥离 `.html`/`/index`"后再次命中自身，判定为无限循环 |
| 修复 | 删除 `public/_redirects`，新增 `wrangler.jsonc`，用 `assets.not_found_handling = "single-page-application"` 实现 SPA 回退 |
| 验证 | `npx wrangler dev` 起真实 workerd：`/`、`/certificates`、`/certificates/<id>`、`/settings`、`/not-exist-page` 全部 200 且返回 index.html；`Parsed 2 valid header rules`；浏览器打开无任何控制台报错 |
