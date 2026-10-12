# iOS Certificate Manager

个人使用的 **iOS 开发证书管理工具**：全部在浏览器本地完成 **CSR 生成 → 导入 Apple 颁发的 CER → 导出 PKCS#12（P12）**，以及本地证书管理、加密备份与恢复。

- 纯前端静态站点（Vue 3 + TypeScript + Vite + Element Plus），可部署到 Cloudflare Pages；
- **不上传任何数据**：私钥、CSR、CER、P12、密码都只在你的浏览器里处理；
- 不自动登录 Apple Developer，也不代你创建证书（Apple 后台步骤需要你手动完成）；
- 所有产物都用外部 **OpenSSL** 做过独立交叉验证，而不是"自己验自己"。

> ⚠️ 这是个人自用工具，不是 Apple 官方产品。请在使用前阅读 [安全设计说明](docs/security.md) 与 [已知限制](docs/known-limitations.md)。

---

## 快速开始

```bash
npm install          # 安装依赖（Node.js >= 20.19）
npm run dev          # 本地开发服务器
npm run build        # 生产构建（含 vue-tsc 类型检查）
npm run preview      # 预览构建产物
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发（默认 http://localhost:5173） |
| `npm run build` | 类型检查 + 生产构建到 `dist/` |
| `npm test` | 运行全部自动化测试（单元 + 集成） |
| `npm run verify:crypto` | **只跑 OpenSSL 独立兼容性验证**（推荐每次改密码学代码后运行） |
| `npm run typecheck` | TypeScript / Vue 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm run check:dist` | 检查构建产物中是否混入私钥/证书/测试密码 |
| `npm run verify:all` | 类型检查 + Lint + 测试 + 构建 + 产物检查（发布前一键） |
| `node scripts/serve-dist.mjs 4174` | 本地静态服务器跑构建产物（含 CSP 与 SPA 回退，等价于线上行为） |
| `npx wrangler dev` | 用**真实 Workers 运行时（workerd）**本地验证部署配置、深链回退与响应头 |

---

## 使用流程

1. **新建 CSR**：输入证书名称（可用中文）与用途，选择 RSA 长度（默认 2048），点击「生成密钥与 CSR」。
   - 浏览器本地生成密钥对与 PKCS#10 CSR；私钥以 AES-256-GCM 密文保存在本机 IndexedDB。
2. **下载 CSR**：列表中点击「下载 CSR」，得到 `.certSigningRequest` 文件。
3. **到 Apple Developer 后台**：Certificates, Identifiers & Profiles → 新建证书 → 上传该 CSR → 下载 Apple 签发的 `.cer`。
4. **导入 CER**：回到列表点击「导入 CER」，选择 `.cer` 文件。工具会解析证书并用**公钥参数**校验它与本地私钥是否匹配。
5. **导出 P12**：状态变为「可导出 P12」后，点击「导出 P12」，设置导出密码与算法（默认 AES-256-CBC / PBES2），下载 `.p12`。
6. **备份**：在「设置与本地数据」页用备份密码导出加密备份，可在**另一台设备/另一个浏览器**恢复。

---

## 功能一览

- 证书列表：分页、名称搜索、状态筛选、CSR/CER/P12 状态、真实有效期（含过期/未生效提示）
- 新建 CSR：真实 RSA 密钥对 + PKCS#10 CSR（中文名称已修复编码问题，见下文）
- CER 导入：DER/PEM 解析，Subject/Issuer/序列号/有效期/公钥/指纹/KeyUsage，公私钥匹配校验
- P12 导出：真实 PKCS#12（PBES2 + AES-256-CBC 或 3DES），导出后自动重新打开自检
- 证书详情：完整字段、失败原因、可否导出 P12 的阻塞原因
- 本地存储：IndexedDB（证书与私钥分表、原子写入、孤立私钥清理）
- 加密备份/恢复：AES-256-GCM + PBKDF2-SHA256（60 万次迭代），支持合并/替换两种恢复方式
- 安全：严格 CSP、无第三方脚本、无外部网络请求

---

## 技术栈

Vue 3 · TypeScript · Vite · Element Plus · Vue Router · IndexedDB（idb）· node-forge（CSR/PKCS#12/X.509 的 ASN.1 处理）· Web Crypto API（RSA 密钥生成、AES-GCM、PBKDF2）· Vitest · ESLint · Prettier

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 架构与模块边界、数据流 |
| [docs/data-model.md](docs/data-model.md) | 数据结构与 IndexedDB 表结构、备份格式 |
| [docs/security.md](docs/security.md) | 安全设计、威胁模型、加密参数 |
| [docs/known-limitations.md](docs/known-limitations.md) | 已知限制与未验证事项 |
| [docs/deployment-cloudflare.md](docs/deployment-cloudflare.md) | Cloudflare Pages 部署与 GitHub 自动部署 |
| [docs/acceptance-checklist.md](docs/acceptance-checklist.md) | 逐项验收清单（含需要你亲自验证的 Apple 侧项目） |
| [docs/testing.md](docs/testing.md) | 测试说明与 OpenSSL 独立验证方法 |

---

## 一个真实修复案例（为什么必须用独立工具验证）

初版用 node-forge 生成 CSR 时，只要证书名称包含中文（非 ASCII），产出的竟然是**非法 DER**，OpenSSL 直接报 `wrong tag` 拒收。
原因是 forge 构造 DN 时默认按 PrintableString 写长度、却不做 UTF8String 编码。修复方式是为每个 subject 字段显式指定 `valueTagClass`
（ASCII → PrintableString，其它 → UTF8String），解析侧对应做 `decodeUtf8`。该问题由 `tests/integration/openssl-compat.test.ts` 独立验证覆盖。

另外还确认了一个容易被误判的点：OpenSSL 3 的 `pkcs12 -info` 打印**非 ASCII 的 friendlyName** 时会丢高字节、显示成乱码，
但字节级断言证明我们写入的是标准 UCS-2 BMPString（`1e 0e 7a ef 52 30 ...`），文件本身没有问题，详见 [已知限制](docs/known-limitations.md)。

---

## 许可

个人项目，未附许可协议。请自行评估使用风险。
