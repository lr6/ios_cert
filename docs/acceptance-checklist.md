# 逐项验收清单

对应说明书各章节。状态含义：

- ✅ **已完成并已验证** —— 有自动化测试或外部工具（OpenSSL）验证证据；
- 🧍 **需要你验证** —— 必须使用真实 Apple 账号 / macOS 环境，本环境无法完成；
- ⚠️ **已实现但有已知限制** —— 见 [known-limitations.md](known-limitations.md)。

验证命令：`npm run verify:all`（类型检查 + Lint + 全部测试 + 构建 + 产物敏感内容检查）

---

## 一、核心原则

| # | 要求 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| 1 | 真实实现 CSR/CER/P12，不用假文件冒充 | ✅ | CSR 由 OpenSSL 独立验签；P12 由 OpenSSL 打开并比对公私钥 |
| 2 | 纯前端，无需 VPS/Node 后端/数据库 | ✅ | 仅静态资源；CSP `connect-src 'self'`，无任何 API 调用 |
| 3 | 浏览器本地加密与本地文件处理，默认不上传 | ✅ | 全部逻辑在 `src/services/**`，无网络请求 |
| 4 | 必须验证生成/导入/导出的真实性与兼容性 | ✅ | `tests/integration/openssl-compat.test.ts`（11 项） |
| 5 | 不把私钥/密码/敏感内容写进控制台 | ✅ | 代码审查；`vue/no-v-html` 与日志约定；无 `console.log` 输出敏感值 |
| 6 | 敏感内容不写入 localStorage | ✅ | 私钥仅以密文存 IndexedDB；全局未使用 localStorage（可搜索验证） |
| 7 | 不宣称浏览器存储绝对安全，说明风险 | ✅ | 设置页安全说明 + [security.md](security.md) |
| 8 | 不确定时先写独立验证程序与测试 | ✅ | 阶段 A 先做加密验证再写 UI；发现并修复中文 CSR 缺陷 |
| 9 | 首版单用户，不做注册/权限/云同步 | ✅ | 无账号体系 |
| 10 | 不把 Pages/Workers/Web Crypto 当可执行 OpenSSL 的服务器 | ✅ | 无服务端逻辑 |

## 二、技术栈

| 要求 | 状态 | 说明 |
| --- | --- | --- |
| Vue 3 + TypeScript + Vite | ✅ | 见 `package.json` |
| Element Plus | ✅ | 全量引入（体积见限制说明） |
| Vue Router | ✅ | `src/router/index.ts` |
| Pinia（仅在需要时） | ✅ | 未引入：项目不需要跨页全局状态 |
| IndexedDB（idb） | ✅ | `src/services/storage/*` |
| Vitest | ✅ | 单元 + 集成测试 |
| ESLint + Prettier | ✅ | `eslint.config.js`、`.prettierrc.json`，`npm run lint` 通过 |
| 浏览器兼容依赖，不依赖 Node 原生模块 | ✅ | 已用真实浏览器验证构建产物可运行 |
| 对库能力必须实测 | ✅ | forge 的 PKCS#8 解析、SHA-256 MAC、中文 DN 编码均已实测 |

## 三、完整业务流程

| # | 步骤 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 打开证书管理首页 | ✅ | `/certificates` |
| 2 | 点击「新建 CSR」 | ✅ | 列表页与空状态均有入口 |
| 3 | 输入名称并选择类型 | ✅ | 表单校验 + 中文支持 |
| 4 | 本地生成密钥对 | ✅ | Web Crypto RSA 2048/3072/4096 |
| 5 | 生成 PKCS#10 CSR | ✅ | OpenSSL 验签通过 |
| 6 | 下载真实 CSR 文件 | ✅ | `.certSigningRequest` |
| 7 | 用户自行到 Apple 后台创建证书 | 🧍 | 工具明确提示需手动完成 |
| 8 | 用户下载 Apple 的 CER | 🧍 | — |
| 9 | 返回网站导入 CER | ✅ | DER 与 PEM 均可 |
| 10 | 解析证书并校验证书与私钥对应关系 | ✅ | 按 RSA 模数/指数比对 |
| 11 | 输入 P12 导出密码 | ✅ | 强度校验 + 二次确认 |
| 12 | 本地生成真实 PKCS#12 | ✅ | OpenSSL 可打开 |
| 13 | 下载 P12 | ✅ | Blob 下载 |
| 14 | 查看信息、重新导出、备份与恢复 | ✅ | 详情页 + 设置页备份/恢复 |

## 四、证书类型与业务状态

| 要求 | 状态 | 说明 |
| --- | --- | --- |
| 至少支持 Development / Distribution | ✅ | 仅作本地归类，界面已说明不代表 Apple 全部分类 |
| 显示所选类型并记录真实导入的证书信息 | ✅ | 列表与详情页均展示真实解析结果 |
| 状态：draft / csr-created / cer-imported / ready / error | ✅ | 见 `CertificateStatus` 与状态机 |
| 状态必须由真实结果驱动 | ✅ | 状态流转集中在 `certificate-service`，非法流转抛错 |

## 五、页面与功能

| 章节 | 要求 | 状态 |
| --- | --- | --- |
| 5.1 | 列表：面包屑、说明、主按钮、8 个列、分页/搜索/筛选/详情/下载 CSR/导入 CER/导出 P12/改名/删除/空状态/加载态/错误态/删除确认 | ✅ |
| 5.1 | 不允许虚构有效期或文件状态 | ✅ 全部来自真实解析 |
| 5.2 | 新建 CSR：名称/用途/密钥长度/备注，真实密钥与 CSR，PEM 下载，状态与错误提示，成功后展示信息，取消不留残记录 | ✅ |
| 5.3 | 私钥独立 KeyRecord、不用 localStorage、密码加密备份、AES-256-GCM、PBKDF2 参数入文件、每次新盐/nonce、失败校验、不存密码、内存中短暂保留、不宣称可擦除内存、提示恶意脚本风险 | ✅ / ⚠️ 本地主密钥方案见 security.md |
| 5.4 | CER 导入：大小/类型检查、DER 与 PEM、解析字段、公私钥匹配、明确错误、不认定任意文件为证书、不只按名称判断、更新真实状态、说明链/吊销无法本地确认 | ✅ |
| 5.5 | P12 导出：仅用匹配的 CER+私钥、密码必填、本地打包、真实兼容文件、不上传、不记日志、明确错误、导出后可解析性验证、独立解析测试、说明 macOS 验证 | ✅ / 🧍 A2、A3 |
| 5.6 | 详情页字段（名称/类型/时间/CSR 状态/CER 状态/Subject/Issuer/Serial/有效期/公钥/指纹/私钥可用性/可否导出） | ✅ |
| 5.7 | IndexedDB 保存元信息/CSR/CER/加密私钥/文件关联/备份版本；仓储层隔离；CRUD/分页/搜索/筛选/迁移/异常处理；删除区分语义 | ✅ |
| 5.8 | 备份：密码、全部记录与私钥、加密格式、AES-256-GCM、PBKDF2、独立盐与 nonce、版本头、数据结构版本、无明文；恢复：选择文件、密码、校验格式与版本、解密验证、结构完整性、预览、合并/替换、失败不破坏原数据、不支持版本明确提示 | ✅ 8 项测试覆盖 |

## 六、界面设计

| 要求 | 状态 |
| --- | --- |
| 简体中文界面、传统后台风格、蓝主色、表格清晰、按钮统一、桌面 + 基本移动端 | ✅ |
| 错误提示明确，不显示笼统「操作失败」 | ✅ |
| 危险操作二次确认 | ✅ 删除、清空、替换恢复 |
| 关键操作加载态，防重复提交 | ✅ |
| 结果按真实执行结果显示 | ✅ |

## 七、项目结构

| 要求 | 状态 |
| --- | --- |
| 加密 / 业务 / 存储 / UI 分离 | ✅ 见 [architecture.md](architecture.md) |
| 目录结构与建议结构一致 | ✅（`src/services/{certificates,crypto,storage,backup}`、`src/types`、`src/utils`、`tests/{unit,integration,fixtures}`） |

## 八、测试要求

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 单元：CSR 编解码、密钥生成、CER 解析、证书私钥匹配、P12 导出解析、加解密、错误密码、备份恢复、IndexedDB CRUD、状态转换、输入校验 | ✅ | 5 个单元测试文件 |
| 集成：新建/生成 CSR/保存密钥/导入 CER/校验/导出 P12/刷新恢复/备份后清空恢复/恢复后重新导出 | ✅ | `certificate-flow.test.ts` + `backup-restore.test.ts` |
| 真实兼容性：Apple CER、CSR 被 Apple 接受、P12 被独立工具解析、macOS 导入、真机签名 | 🧍 / ✅ | 独立工具（OpenSSL）解析 ✅；Apple 侧三项 🧍 |
| 不应用假证书宣称兼容性 | ✅ | 文档中明确区分"已验证"与"需你验证" |

## 九、Cloudflare Pages 部署

| # | 要求 | 状态 |
| --- | --- | --- |
| 1 | 完整 package.json | ✅ |
| 2 | 生产构建脚本 | ✅ `npm run build` |
| 3 | SPA 路由回退 | ✅ `wrangler.jsonc` 的 `assets.not_found_handling: "single-page-application"`（Workers 静态资源不支持 `_redirects` 里的 `/* /index.html 200`，会被判定为无限循环） |
| 4 | 刷新详情页不 404 | ✅ 用 `wrangler dev`（真实 workerd 运行时）实测 `/certificates/<id>`、`/settings` 等深链均返回 200 + index.html；另有本地静态服务器与浏览器实测 |
| 5 | 依赖支持浏览器环境 | ✅ 真实浏览器运行验证 |
| 6 | 不依赖本地文件系统执行 OpenSSL | ✅ 运行时不调用任何外部进程 |
| 7 | 不依赖服务器进程 | ✅ |
| 8 | 不要求数据库 | ✅ |
| 9 | 不把密钥/密码写进环境变量 | ✅ 部署不需要任何环境变量 |
| 10 | 提供 Pages 构建说明 | ✅ [deployment-cloudflare.md](deployment-cloudflare.md) |
| 11 | 提供 GitHub 连接与自动部署说明 | ✅ 同上 |
| 12 | 提供本地开发/构建/测试命令 | ✅ README |
| 13 | 检查构建产物是否含敏感文件 | ✅ `npm run check:dist` |
| 14 | 部署后浏览器安全问题说明 | ✅ [security.md](security.md) 第 3 节 |

## 十、开发执行顺序

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| A 环境检查与加密方案验证 | ✅ | 先做独立验证模块与 OpenSSL 交叉验证，发现并修复中文 CSR 缺陷 |
| B 项目骨架 | ✅ | Vue 3 + TS + Element Plus + Router + Vitest |
| C 本地存储 | ✅ | 数据模型 + IndexedDB + CRUD/查询/删除/异常处理 |
| D CSR 与私钥 | ✅ | RSA 密钥、CSR、密钥保存、加密备份、测试通过 |
| E CER 与 P12 | ✅ | 解析、匹配校验、真实 PKCS#12、输出验证 |
| F 完整备份与恢复 | ✅ | 版本控制、加密导出与恢复、错误密码/损坏/恢复失败测试 |
| G 安全检查与部署 | ✅ | 全量测试、生产构建、依赖与敏感数据检查、部署说明、验收清单 |

## 十一、开发纪律

| # | 要求 | 遵守情况 |
| --- | --- | --- |
| 1–2 | 先检查工作区、不覆盖已有项目 | ✅ 工作区原为空，从零建立 |
| 3–4 | 不一次性堆砌未测试代码；每阶段跑测试 | ✅ 每阶段均运行测试 |
| 5 | 依赖不兼容时查文档/类型定义，不猜测 | ✅ 通过实测确认 forge 的 PKCS#8、MAC、DN 编码行为 |
| 6 | 不为让测试通过而删除关键断言 | ✅ 修正的是实现与断言口径，未弱化验证 |
| 7 | 不用 TODO/占位函数冒充完成 | ✅ 无未实现的占位功能 |
| 8 | 无真实证书时不伪造测试结果 | ✅ 已在文档中标注 A1–A3 待验证 |
| 9 | 对不可行功能给出有证据的替代方案 | ✅ 中文 friendlyName 乱码问题给出字节级证据与规避方案 |
| 10 | 重大风险先说明再实施 | ✅ 私钥解锁模型已在开工前说明 |
| 11 | 不因缺少真实证书停止开发 | ✅ 完成全部可独立验证的部分 |
| 12 | 未实际部署就不得宣称部署成功 | ✅ **本项目未执行真实部署**，仅提供部署说明与本地等价验证 |

## 十二、最终交付物

| # | 交付物 | 位置 | 状态 |
| --- | --- | --- | --- |
| 1 | 可运行完整源码 | 仓库根目录 | ✅ |
| 2 | README | `README.md` | ✅ |
| 3 | Cloudflare Pages 部署说明 | `docs/deployment-cloudflare.md` | ✅ |
| 4 | 本地启动说明 | README「快速开始」 | ✅ |
| 5 | 自动化测试 | `tests/**`（53+ 项） | ✅ |
| 6 | 测试结果与构建结果 | 见 [testing.md](testing.md) 与本文件 | ✅ |
| 7 | 技术架构说明 | `docs/architecture.md` | ✅ |
| 8 | 数据结构说明 | `docs/data-model.md` | ✅ |
| 9 | 安全设计说明 | `docs/security.md` | ✅ |
| 10 | 真实 Apple 证书兼容性验证结果 | [known-limitations.md](known-limitations.md) 第 1 节（明确标注未完成项） | 🧍 |
| 11 | 已知限制与改进建议 | `docs/known-limitations.md` | ✅ |
| 12 | 逐项验收清单 | 本文件 | ✅ |

---

## 你还需要做的三件事

1. **A1**：用本工具生成 CSR → 到 Apple Developer 后台创建证书，确认后台接受；
2. **A2**：导入 Apple 返回的 CER → 导出 P12 → 在 macOS 钥匙串导入，确认能看到证书与私钥；
3. **A3**：用该 P12 在 Xcode 中完成一次真机签名/发布流程。

完成后建议把结果记录下来，并更新 [known-limitations.md](known-limitations.md) 第 1 节的状态。
