# 测试说明

## 1. 如何运行

```bash
npm test              # 全部测试（单元 + 集成）
npm run verify:crypto # 只跑 OpenSSL 独立兼容性验证
```

OpenSSL 二进制会被自动探测，顺序为：环境变量 `OPENSSL_BIN` → PATH 中的 `openssl` →
`C:\Program Files\Git\usr\bin\openssl.exe` → `/usr/bin/openssl`。

如果本机没有 OpenSSL，涉及独立验证的用例会被**跳过**（并打印警告），其它测试照常运行。
构建产物与浏览器端功能不依赖本机 OpenSSL——它只用于开发和验证阶段。

## 2. 测试清单

### 单元测试（`tests/unit/`）

| 文件 | 覆盖内容 |
| --- | --- |
| `csr.test.ts` | 密钥生成（含非法长度拒绝）、CSR 生成/解析/验签、中文名称编码回归、篡改必须验签失败 |
| `x509.test.ts` | PEM/DER 证书解析、字段与 OpenSSL 输出一致、指纹/序列号、公私钥匹配与不匹配原因、非法输入拒绝 |
| `pkcs12.test.ts` | 导出后可用正确密码打开、错误密码失败、篡改失败、不匹配拒绝打包、额外证书保留、3DES 变体、产物不可重复 |
| `encryption.test.ts` | AES-GCM 往返、错误密码、密文篡改、版本不支持、盐/nonce 随机性、空密码拒绝、迭代次数下限、AAD 校验 |
| `storage.test.ts` | IndexedDB CRUD、原子写入、分页/搜索/筛选/排序、状态计数、删除语义（含/不含私钥）、孤立私钥检测 |

### 集成测试（`tests/integration/`）

| 文件 | 覆盖内容 |
| --- | --- |
| `openssl-compat.test.ts` | **OpenSSL 独立验证**：CSR 验签与字段、中文 CSR、公钥一致、证书指纹一致、P12 可打开且公私钥一致、错误密码失败、3DES 变体、双向互通（读取 OpenSSL 传统/现代 P12）、friendlyName 的 BMPString 字节级断言 |
| `certificate-flow.test.ts` | 完整业务流：新建→导入匹配 CER→导出 P12；不匹配 CER 必须置 error；密码强度校验；改名/删除；刷新后持久化 |
| `backup-restore.test.ts` | 备份不含明文私钥/密码、错误密码、损坏文件、版本不支持、结构校验、**清空后恢复并重新导出 P12（OpenSSL 验证）**、合并/替换模式、跨设备恢复（新主密钥） |

## 3. 为什么要有"独立验证"

只用生成文件的同一个库去校验文件，等于自己验自己。因此：

- 所有 CSR / P12 / 证书的兼容性断言都由**外部 OpenSSL 进程**完成（`tests/helpers/openssl.ts`）；
- 证书指纹、序列号、公钥这些关键字段，都与 OpenSSL 的输出逐字比对；
- 结构性断言（例如 P12 中 PBES2 / AES-256-CBC / 3DES 的 OID、friendlyName 的 BMPString）直接扫描 DER 字节，不经过 node-forge。

## 4. 浏览器端人工/自动化验证记录

除自动化测试外，本项目在真实 Chromium 中做过端到端验证，结论如下（可用同样步骤复现）：

1. 新建中文名称证书 → 页面显示 `CN=示例开发证书 / RSA 2048 / SHA256withRSA / 自校验通过`；
2. 取出浏览器生成的 CSR 交给 OpenSSL → `verify OK`，`CN=示例开发证书`；
3. 刷新页面记录仍在（IndexedDB 持久化 + 主密钥可读）；
4. 硬刷新 `/certificates/<id>` 不 404（SPA 回退）；
5. 导入不属于该密钥的证书 → 状态变「处理失败」并显示真实原因；
6. 用 Node 生成的加密备份文件在**全新浏览器配置**中恢复 → 记录与私钥恢复成功，「本地主密钥」自动重建；
7. 恢复后在浏览器中导出 P12 → 下载文件交给 OpenSSL：正确密码可打开、提取的证书与私钥公钥一致、指纹匹配、错误密码失败。

## 5. 部署形态验证（Cloudflare Workers 静态资源）

线上用的是 **Workers + 静态资源**（不是 Pages），因此额外做了运行时级别的验证：

1. `npx wrangler deploy --dry-run` → 配置解析正常、读到 `dist` 下全部资源；
2. `npx wrangler dev`（真实 workerd 运行时）：
   - `/`、`/certificates`、`/certificates/<id>`、`/settings`、`/not-exist-page` 全部返回 **200 + index.html**（SPA 回退生效，日志显示 `using not_found_handling behavior`）；
   - `Parsed 2 valid header rules`（`_headers` 里的 CSP 等响应头已应用）；
   - 静态资源（`/assets/*.js`、`/favicon.svg`）均 200。
3. 用浏览器打开 `http://127.0.0.1:8788/certificates/<id>`：应用正常启动，**控制台 0 错误 0 警告**（说明严格 CSP 与应用的实现兼容）。

> 历史故障：最初在 `public/_redirects` 里写了 Pages 风格的 `/*  /index.html  200`，Workers 服务端校验判定为无限循环（`code 100324`）导致部署失败。已改为 `wrangler.jsonc` 的 `assets.not_found_handling = "single-page-application"`，并在上面用真实运行时验证通过。

## 5. 尚未完成的验证

Apple 侧的三项（后台接受 CSR、macOS 钥匙串导入 P12、真机签名）需要真实账号与 macOS 环境，
本环境无法完成，详见 [known-limitations.md](known-limitations.md) 与 [acceptance-checklist.md](acceptance-checklist.md)。
