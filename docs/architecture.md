# 技术架构说明

## 1. 总体架构

纯前端静态站点。没有后端、没有数据库服务、没有服务端 API，也不依赖任何 Node.js 运行时能力。

```
浏览器
├─ 视图层（Vue 3 + Element Plus）
│   ├─ CertificatesView        证书列表（分页/搜索/筛选/操作）
│   ├─ CertificateCreateView   新建 CSR
│   ├─ CertificateDetailView   证书详情 + 导入 CER + 导出 P12
│   └─ SettingsView            备份 / 恢复 / 本地存储 / 危险操作
├─ 业务编排层
│   └─ certificate-service     状态机 + 完整业务流程编排
│   └─ backup-service          加密备份与恢复
├─ 密码学与文件层
│   ├─ csr-service             RSA 密钥生成（Web Crypto）+ PKCS#10（node-forge）
│   ├─ x509-service            X.509 解析、公私钥匹配、指纹
│   ├─ pkcs12-service          PKCS#12 打包与解析
│   ├─ encryption-service      AES-256-GCM / PBKDF2 / 备份信封
│   └─ key-management-service  本地主密钥（vault）与私钥封装
└─ 存储层（IndexedDB）
    ├─ database                连接、结构迁移、统计
    ├─ certificate-repository  证书 CRUD / 分页 / 搜索 / 筛选
    └─ key-repository          私钥记录读写
```

分层规则（对应说明书第七章）：

1. **Vue 组件不直接访问 IndexedDB**，一律通过仓储层；
2. **密码学逻辑不依赖 UI**，可以在 Node（测试）与浏览器中同样运行；
3. **业务状态只能由真实执行结果驱动**：状态流转集中在 `certificate-service` 的状态机里，非法流转直接抛错。

## 2. 关键设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| RSA 密钥生成 | Web Crypto API（`extractable: true`） | 原生实现快（2048 位约 200ms）、随机源可信；必须可导出才能备份 |
| CSR / X.509 / PKCS#12 的 ASN.1 处理 | node-forge | 纯 JS、Vite 可打包、CSR 与 P12 共用同一套对象模型，避免格式互转风险 |
| 对称加密 / KDF / 随机数 | Web Crypto API | 明文私钥封装、备份加密都用原生 AES-GCM 与 PBKDF2 |
| 私钥落盘方式 | AES-256-GCM 密文 + 不可导出主密钥（存 IndexedDB） | 密钥不可导出为字节；同时保证日常操作无需反复输密码 |
| 备份的可移植性 | 备份内重新用**备份密码**加密（不复用本机主密钥） | 备份必须能在其它设备恢复 |
| 搜索实现 | 内存过滤 + IDB 索引 | 个人工具数据量小（数十条），行为可预期且避免复杂索引 |

### 2.1 私钥封装的 AAD 绑定

私钥密文的附加认证数据为 `ioscert-key|<certificateId>`，即密文与所属证书强绑定。这样可以防止把 A 证书的私钥密文替换到 B 记录上（替换后解密会失败）。

### 2.2 状态机

```
draft ──▶ csr-created ──▶ cer-imported ──▶ ready
  │            │                │            │
  └────────────┴────────────────┴────────────┴──▶ error
```

- `csr-created`：密钥与 CSR 生成并自校验通过后写入；
- `ready`：CER 导入且与私钥匹配成功；
- `error`：任何真实失败（证书不匹配、P12 自检失败等），同时写入 `lastError` 供界面展示。

## 3. 主要数据流

### 3.1 新建证书

```
表单 → 校验名称 → Web Crypto 生成 RSA 密钥对（PKCS#8 + SPKI）
   → forge 生成 PKCS#10 CSR（subject 显式 valueTagClass，支持中文）
   → CSR 内部验签（失败即中止）
   → 用主密钥 AES-GCM 封装私钥（AAD 绑定 certificateId）
   → 单个 IDB 事务写入 keys + certificates
```

### 3.2 导入 CER

```
文件 → 大小/格式检查 → DER 或 PEM 解析（失败直接抛错，不产生假记录）
   → 提取 Subject/Issuer/序列号/有效期/公钥/指纹
   → 解封私钥，比较 RSA 模数 + 指数
   → 匹配：状态置 ready；不匹配：状态置 error 并写入真实原因
```

### 3.3 导出 P12

```
校验密码强度 → 读记录（必须有 CER + 私钥）
   → 解封私钥 → 再次校验证书与私钥匹配（不匹配则置 error 并中止）
   → forge 打包 PKCS#12（PBES2 + AES-256-CBC，含 friendlyName/localKeyId/MAC）
   → 用同一密码重新解析自检（校验包内私钥与证书匹配）
   → 记录导出时间 → 浏览器 Blob 下载
```

### 3.4 备份与恢复

```
备份：遍历证书 → 解封私钥 → 组装明文负载 → PBKDF2(密码, 随机盐, 600k) → AES-256-GCM → JSON 信封下载
恢复：解析 JSON → 校验信封 → 派生密钥解密 → 校验负载结构/版本/记录数
     → 预览（不写入） → 用户选择合并或替换
     → 用当前设备主密钥重新封装每个私钥 → 单个 IDB 事务写入
```

## 4. 构建与部署

- 构建命令 `npm run build`，输出 `dist/`；
- SPA 回退由 `public/_redirects`（`/* /index.html 200`）处理，刷新详情页不会 404；
- 安全响应头位于 `public/_headers`（严格 CSP、nosniff、DENY frame 等）；
- `scripts/serve-dist.mjs` 在本地复现相同的响应头与回退行为，便于验证；
- 详细部署步骤见 [deployment-cloudflare.md](deployment-cloudflare.md)。
