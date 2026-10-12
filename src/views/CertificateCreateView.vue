<template>
  <div class="page">
    <div class="card">
      <h2 class="section-title">新建 CSR 文件</h2>
      <p class="hint">
        本页会在你的浏览器本地生成 RSA 密钥对与 PKCS#10 CSR 文件。私钥会以 AES-256-GCM 密文保存在本机浏览器数据库中，
        不会上传；CSR 需要你手动带到 Apple Developer 后台创建证书。
      </p>

      <el-alert
        v-if="created"
        type="success"
        :closable="false"
        show-icon
        title="CSR 已生成（已通过自校验）"
        style="margin: 12px 0"
      >
        <div class="hint" style="margin-top: 6px">
          下一步：下载 CSR 文件 → 打开 Apple Developer 后台（Certificates, Identifiers &amp; Profiles）→
          新建证书并上传该 CSR → 下载 Apple 生成的 .cer 文件 → 回到本页的证书列表导入 CER。
        </div>
      </el-alert>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="120px"
        style="max-width: 620px"
        :disabled="submitting"
      >
        <el-form-item label="证书名称" prop="name">
          <el-input v-model="form.name" maxlength="128" show-word-limit placeholder="例如：示例 App 开发证书" />
          <div class="hint">用于本地识别，会写入 CSR 的 CN 字段；Apple 会用你的账号信息覆盖证书显示名。</div>
        </el-form-item>

        <el-form-item label="证书用途" prop="purpose">
          <el-radio-group v-model="form.purpose">
            <el-radio-button value="development">Development</el-radio-button>
            <el-radio-button value="distribution">Distribution</el-radio-button>
          </el-radio-group>
          <div class="hint">该选项仅用于本地归类，实际证书类型取决于你在 Apple 后台创建的证书。</div>
        </el-form-item>

        <el-form-item label="RSA 密钥长度" prop="bits">
          <el-select v-model="form.bits" style="width: 200px">
            <el-option :value="2048" label="2048 位（默认，兼容性最好）" />
            <el-option :value="3072" label="3072 位" />
            <el-option :value="4096" label="4096 位（生成较慢）" />
          </el-select>
        </el-form-item>

        <el-form-item label="组织（可选）" prop="organization">
          <el-input v-model="form.organization" maxlength="64" placeholder="将写入 CSR 的 O 字段" />
        </el-form-item>

        <el-form-item label="备注（可选）" prop="note">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="200" show-word-limit />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">
            {{ submitting ? submittingText : '生成密钥与 CSR' }}
          </el-button>
          <el-button :disabled="submitting" @click="router.push('/certificates')">返回列表</el-button>
        </el-form-item>
      </el-form>

      <el-divider v-if="created" content-position="left">CSR 信息（来自真实生成结果）</el-divider>

      <el-descriptions v-if="created" :column="1" border size="small" style="max-width: 720px">
        <el-descriptions-item label="Common Name">{{ created.csrInfo?.subject.commonName }}</el-descriptions-item>
        <el-descriptions-item v-if="created.csrInfo?.subject.organization" label="Organization">
          {{ created.csrInfo?.subject.organization }}
        </el-descriptions-item>
        <el-descriptions-item label="公钥算法">
          {{ created.csrInfo?.publicKeyAlgorithm }} {{ created.csrInfo?.publicKeyBits }} 位
        </el-descriptions-item>
        <el-descriptions-item label="签名算法">{{ created.csrInfo?.signatureAlgorithm }}</el-descriptions-item>
        <el-descriptions-item label="自校验">
          <el-tag type="success" size="small">通过</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="生成时间">{{ formatDateTime(created.csrCreatedAt) }}</el-descriptions-item>
      </el-descriptions>

      <div v-if="created" class="toolbar" style="margin-top: 12px">
        <el-button type="primary" :icon="Download" @click="downloadCsr">下载 CSR 文件</el-button>
        <el-button @click="router.push(`/certificates/${created.id}`)">查看证书详情</el-button>
        <div class="spacer"></div>
        <span class="hint">请妥善保管：私钥仅保存在本机浏览器中，清除浏览器数据将导致私钥丢失。</span>
      </div>

      <el-divider v-if="created" content-position="left">CSR 内容（PEM）</el-divider>
      <pre v-if="created" class="mono pem-block">{{ created.csrPem }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import type { CertificatePurpose, RsaKeyBits } from '@/types/certificate'
import type { CertificateRecord } from '@/types/record'
import { createCertificateWithCsr } from '@/services/certificates/certificate-service'
import { downloadText, formatDateTime } from '@/utils/file-download'
import { describeError } from '@/utils/errors'
import { sanitizeFileName, validateCertificateName } from '@/utils/validation'

const router = useRouter()
const formRef = ref<FormInstance>()
const submitting = ref(false)
const submittingText = ref('正在生成密钥…')
const created = ref<CertificateRecord | null>(null)

const form = reactive({
  name: '',
  purpose: 'development' as CertificatePurpose,
  bits: 2048 as RsaKeyBits,
  organization: '',
  note: ''
})

const rules: FormRules = {
  name: [
    { required: true, message: '请输入证书名称', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        const error = validateCertificateName(value ?? '')
        callback(error ? new Error(error) : undefined)
      },
      trigger: 'blur'
    }
  ]
}

async function submit(): Promise<void> {
  const formInstance = formRef.value
  if (!formInstance) return
  const valid = await formInstance.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  submittingText.value = '正在生成密钥与 CSR…'
  try {
    // 大密钥生成耗时较长，先让浏览器把加载态渲染出来
    await new Promise((resolve) => setTimeout(resolve, 30))
    created.value = await createCertificateWithCsr({
      name: form.name,
      purpose: form.purpose,
      bits: form.bits,
      note: form.note,
      organization: form.organization || undefined
    })
    ElMessage.success('CSR 生成成功，请立即下载并妥善保存')
  } catch (error) {
    ElMessage.error(`生成 CSR 失败：${describeError(error)}`)
  } finally {
    submitting.value = false
    submittingText.value = '正在生成密钥…'
  }
}

function downloadCsr(): void {
  if (!created.value?.csrPem) return
  downloadText(
    created.value.csrPem,
    `${sanitizeFileName(created.value.name)}.certSigningRequest`,
    'text/plain;charset=utf-8'
  )
}
</script>

<style scoped>
.pem-block {
  background: #f7f8fa;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px;
  max-height: 260px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
}
</style>
