# 数据结构说明

## 1. IndexedDB

数据库名：`ios-certificate-manager`，当前结构版本：`1`（见 `src/services/storage/database.ts`）。

| Object Store | keyPath | 索引 | 内容 |
| --- | --- | --- | --- |
| `certificates` | `id` | `by-updatedAt`、`by-status`、`by-name` | 证书元信息、CSR 文本、CER 数据、P12 导出记录 |
| `keys` | `id` | `by-certificateId` | 加密后的私钥材料（密文）与公钥信息 |
| `vault` | `id` | — | 本地主密钥（不可导出的 CryptoKey）与自检值 |
| `meta` | `key` | — | 结构版本等元信息 |

结构变更集中在 `upgrade(db, oldVersion)` 回调里，按版本分支迁移。

## 2. CertificateRecord（certificates）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | UUID |
| `name` | string | 证书名称（本地识别用，会写入 CSR 的 CN） |
| `purpose` | `'development' \| 'distribution'` | 本地归类，不代表 Apple 全部证书类型 |
| `status` | `draft \| csr-created \| cer-imported \| ready \| error` | 只能由真实结果流转 |
| `keyId` | string \| null | 关联的私钥记录；删除私钥后为 null |
| `csrPem` / `csrDerBase64` / `csrInfo` / `csrCreatedAt` | — | CSR 文本、DER(base64) 与解析结果 |
| `cerPem` / `cerDerBase64` / `cerInfo` / `cerImportedAt` / `cerFileName` | — | 导入的 Apple 证书及其解析结果 |
| `p12ExportedAt` / `p12Algorithm` / `p12FriendlyName` / `p12ChainLength` | — | P12 导出记录（**不含密码**） |
| `note` | string? | 用户备注 |
| `lastError` | string? | 最近一次真实失败原因 |
| `createdAt` / `updatedAt` | ISO string | 时间戳 |

## 3. KeyRecord（keys）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `certificateId` | 所属证书 |
| `algorithm` / `bits` | 固定 `'RSA'`，2048/3072/4096 |
| `sealedPrivateKey` | `{ iv, data }`，AES-256-GCM 密文（base64），AAD = `ioscert-key\|<certificateId>` |
| `publicKeyPem` | SPKI 公钥（公钥不敏感） |
| `modulusHex` | RSA 模数，用于快速比对 |

> **注意**：任何地方都不得把 PKCS#8 明文私钥写入 IndexedDB、localStorage、URL 或日志。测试中有专门断言检查这一点。

## 4. VaultRecord（vault，单例）

| 字段 | 说明 |
| --- | --- |
| `id` | 固定 `'vault'` |
| `version` | 主密钥记录版本 |
| `key` | 不可导出的 AES-GCM CryptoKey（以结构化克隆存入） |
| `check` | 用主密钥加密的固定自检值，用于确认主密钥与数据匹配 |
| `createdAt` | 创建时间 |

如果 `vault` 记录丢失但 `keys` 中仍有密文，程序会**明确报错并拒绝新建主密钥**（避免把已有私钥变成永久无法解密）。这种情况下请用备份恢复。

## 5. 备份文件格式（.json）

```jsonc
{
  "format": "ioscert-backup",       // 固定标识
  "version": 1,                     // 加密信封版本
  "dataVersion": 1,                 // 明文负载版本
  "createdAt": "2026-10-12T02:00:00.000Z",
  "kdf":  { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64 16B>" },
  "cipher": { "name": "AES-GCM", "keyLength": 256, "iv": "<base64 12B>", "tagLength": 128 },
  "ciphertext": "<base64，AES-256-GCM 密文（含 tag）>",
  "note": "可选备注"
}
```

解密后的负载：

```jsonc
{
  "app": "ios-certificate-manager",
  "payloadVersion": 1,
  "createdAt": "…",
  "schemaVersion": 1,                // 导出时的本地结构版本
  "certificates": [ /* CertificateRecord[] */ ],
  "keys": [ /* 与 KeyRecord 相同，但 sealedPrivateKey 换成 privateKeyPem（明文 PKCS#8） */ ]
}
```

要点：

- AAD 绑定 `ioscert-backup|v<version>`，头部被篡改会导致解密失败；
- 私钥明文只存在于**加密负载内部**，备份文件本身不含任何明文私钥；
- 负载结构、版本、记录数（上限 5000）都会严格校验，非法即拒绝、不写入任何数据；
- 恢复时可选择 `merge`（跳过同 id 记录）或 `replace`（先清空再写入）。

## 6. 导出文件命名

| 文件 | 命名规则 |
| --- | --- |
| CSR | `<清洗后的证书名>.certSigningRequest` |
| P12 | `<清洗后的证书名>.p12` |
| 备份 | `ioscert-backup-<ISO 时间戳去分隔符>.json` |

文件名会去掉路径分隔符与控制字符（`src/utils/validation.ts` 的 `sanitizeFileName`）。
