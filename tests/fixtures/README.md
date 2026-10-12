# 测试夹具目录

**这个目录不保存任何密钥或证书文件。**

历史上这里曾经提交过一对自签测试密钥（`test-key.pem` / `test-cert.pem`），
现在改为在测试运行时现场生成：

- 生成逻辑见 [`tests/helpers/fixture.ts`](../helpers/fixture.ts)；
- 每次运行测试都会新生成一对 RSA 2048 密钥与一张自签证书（CN 固定为 `Test Fixture Certificate`），
  不落盘、不提交；
- 真正的"外部工具交叉验证"在 `tests/integration/openssl-compat.test.ts` 里完成：
  那里用 OpenSSL 现场签发证书，并把指纹、序列号、公钥等与 OpenSSL 的输出逐字比对。

这样做的原因：任何 PEM 私钥一旦进入版本库，都会触发代码托管平台的私钥告警，
也容易被误认为真实密钥。密钥材料只应存在于用户自己的浏览器与备份文件里。
