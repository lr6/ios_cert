<template>
  <div v-loading="loading" class="page">
    <div class="card">
      <div class="toolbar">
        <h2 class="section-title">证书详情</h2>
        <div class="spacer"></div>
        <el-button :icon="Back" @click="router.push('/certificates')">返回列表</el-button>
      </div>

      <template v-if="detail">
        <el-alert
          v-if="detail.blocker"
          type="warning"
          :closable="false"
          show-icon
          :title="`当前状态：${CERTIFICATE_STATUS_LABELS[detail.record.status]}`"
          :description="detail.blocker"
        />
        <el-alert
          v-else
          type="success"
          :closable="false"
          show-icon
          title="证书与私钥已校验匹配，可以导出 P12"
          description="导出前会再次校验一次；导出后建议在 macOS 钥匙串或 Xcode 中实际导入验证。"
        />

        <el-descriptions :column="2" border style="margin-top: 16px">
          <el-descriptions-item label="证书名称">{{ detail.record.name }}</el-descriptions-item>
          <el-descriptions-item label="证书类型">
            {{ CERTIFICATE_PURPOSE_LABELS[detail.record.purpose] }}
          </el-descriptions-item>
          <el-descriptions-item label="业务状态">
            {{ CERTIFICATE_STATUS_LABELS[detail.record.status] }}
          </el-descriptions-item>
          <el-descriptions-item label="本地私钥">
            <el-tag :type="detail.hasPrivateKey ? 'success' : 'danger'" size="small" effect="plain">
              {{ detail.hasPrivateKey ? '可用' : '不可用（已删除或丢失）' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDateTime(detail.record.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ formatDateTime(detail.record.updatedAt) }}</el-descriptions-item>
          <el-descriptions-item label="CSR 生成">
            {{ detail.record.csrCreatedAt ? formatDateTime(detail.record.csrCreatedAt) : '未生成' }}
          </el-descriptions-item>
          <el-descriptions-item label="CER 导入">
            {{ detail.record.cerImportedAt ? formatDateTime(detail.record.cerImportedAt) : '未导入' }}
            <span v-if="detail.record.cerFileName" class="hint">（{{ detail.record.cerFileName }}）</span>
          </el-descriptions-item>
          <el-descriptions-item label="P12 导出">
            {{ detail.record.p12ExportedAt ? formatDateTime(detail.record.p12ExportedAt) : '未导出' }}
          </el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.record.note || '—' }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detail.record.lastError"
          type="error"
          :closable="false"
          show-icon
          title="最近一次失败原因"
          :description="detail.record.lastError"
          style="margin-top: 12px"
        />

        <el-divider content-position="left">证书信息（来自导入的 CER 实际内容）</el-divider>

        <el-descriptions v-if="detail.record.cerInfo" :column="1" border size="small">
          <el-descriptions-item label="Subject">{{ detail.record.cerInfo.subject }}</el-descriptions-item>
          <el-descriptions-item label="Issuer">{{ detail.record.cerInfo.issuer }}</el-descriptions-item>
          <el-descriptions-item label="Serial Number">
            <span class="mono">{{ detail.record.cerInfo.serialNumber }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="Not Before">{{
            formatDateTime(detail.record.cerInfo.notBefore)
          }}</el-descriptions-item>
          <el-descriptions-item label="Not After">
            {{ formatDateTime(detail.record.cerInfo.notAfter) }}
            <el-tag v-if="detail.record.cerInfo.expired" type="danger" size="small" style="margin-left: 6px"
              >已过期</el-tag
            >
            <el-tag v-else-if="detail.record.cerInfo.notYetValid" type="warning" size="small" style="margin-left: 6px"
              >尚未生效</el-tag
            >
            <el-tag v-else type="success" size="small" style="margin-left: 6px">有效期内</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="公钥">{{ detail.record.cerInfo.publicKeyAlgorithm }}</el-descriptions-item>
          <el-descriptions-item label="签名算法">{{ detail.record.cerInfo.signatureAlgorithm }}</el-descriptions-item>
          <el-descriptions-item label="SHA-256 指纹">
            <span class="mono">{{ detail.record.cerInfo.sha256Fingerprint }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="SHA-1 指纹">
            <span class="mono">{{ detail.record.cerInfo.sha1Fingerprint }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="Key Usage">{{
            detail.record.cerInfo.keyUsage?.join(', ') || '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="Extended Key Usage">
            {{ detail.record.cerInfo.extendedKeyUsage?.join(', ') || '—' }}
          </el-descriptions-item>
        </el-descriptions>
        <p v-else class="hint">尚未导入 CER 证书。</p>

        <el-divider content-position="left">操作</el-divider>
        <div class="toolbar">
          <el-button :disabled="!detail.record.csrPem" :icon="Download" @click="downloadCsr">下载 CSR</el-button>
          <el-button @click="pickCerFile">导入 / 重新导入 CER</el-button>
          <el-button type="primary" :disabled="!detail.canExportP12" @click="openExportDialog">导出 P12</el-button>
        </div>

        <el-alert type="info" :closable="false" title="关于无法在本工具验证的事项" style="margin-top: 12px">
          <div class="hint">
            证书链完整性、证书是否被撤销、以及该证书在 Apple 开发者账号中的权限，无法仅凭本地文件确认。 请在 Apple
            Developer 后台核对证书状态，并在目标 macOS / Xcode 环境中实际导入 P12 验证签名流程。
          </div>
        </el-alert>
      </template>

      <el-empty v-else-if="!loading" description="证书记录不存在或已被删除">
        <el-button type="primary" @click="router.push('/certificates')">返回列表</el-button>
      </el-empty>
    </div>

    <input
      ref="fileInputRef"
      type="file"
      accept=".cer,.crt,.pem,.der"
      style="display: none"
      @change="onCerFileChosen"
    />

    <el-dialog v-model="exportDialog.visible" title="导出 P12" width="520px">
      <el-form label-width="120px">
        <el-form-item label="密钥加密算法">
          <el-select v-model="exportDialog.algorithm" style="width: 100%">
            <el-option label="AES-256-CBC (PBES2，推荐)" value="aes256" />
            <el-option label="3DES (兼容模式，旧工具链)" value="3des" />
          </el-select>
        </el-form-item>
        <el-form-item label="导出密码" required>
          <el-input v-model="exportDialog.password" type="password" show-password placeholder="至少 8 位" />
        </el-form-item>
        <el-form-item label="确认密码" required>
          <el-input v-model="exportDialog.confirm" type="password" show-password placeholder="再次输入" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="exportDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="exportDialog.loading" @click="submitExport">导出并下载</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Back, Download } from '@element-plus/icons-vue'
import { CERTIFICATE_PURPOSE_LABELS, CERTIFICATE_STATUS_LABELS } from '@/types/certificate'
import {
  exportP12,
  getCertificateDetail,
  importCer,
  type CertificateDetail
} from '@/services/certificates/certificate-service'
import type { Pkcs12Algorithm } from '@/services/certificates/pkcs12-service'
import { downloadBytes, downloadText, formatDateTime, readFileBytes } from '@/utils/file-download'
import { describeError } from '@/utils/errors'
import {
  sanitizeFileName,
  validateCerFileSize,
  validatePasswordConfirmation,
  validateP12Password
} from '@/utils/validation'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const detail = ref<CertificateDetail | null>(null)
const fileInputRef = ref<HTMLInputElement>()

const exportDialog = reactive({
  visible: false,
  password: '',
  confirm: '',
  algorithm: 'aes256' as Pkcs12Algorithm,
  loading: false
})

const certificateId = String(route.params.id ?? '')

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  try {
    detail.value = await getCertificateDetail(certificateId)
  } catch (error) {
    detail.value = null
    ElMessage.error(`读取证书详情失败：${describeError(error)}`)
  } finally {
    loading.value = false
  }
}

function downloadCsr(): void {
  const record = detail.value?.record
  if (!record?.csrPem) return
  downloadText(record.csrPem, `${sanitizeFileName(record.name)}.certSigningRequest`, 'text/plain;charset=utf-8')
}

function pickCerFile(): void {
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
    fileInputRef.value.click()
  }
}

async function onCerFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const sizeError = validateCerFileSize(file.size)
  if (sizeError) {
    ElMessage.error(sizeError)
    return
  }

  loading.value = true
  try {
    const result = await importCer(certificateId, { data: await readFileBytes(file), fileName: file.name })
    if (result.matchesPrivateKey) {
      ElMessage.success(`导入成功：${result.message}`)
    } else {
      ElMessage.error(`导入的证书与私钥不匹配：${result.message}`)
    }
    await load()
  } catch (error) {
    ElMessage.error(`导入 CER 失败：${describeError(error)}`)
  } finally {
    loading.value = false
  }
}

function openExportDialog(): void {
  exportDialog.password = ''
  exportDialog.confirm = ''
  exportDialog.algorithm = (detail.value?.record.p12Algorithm as Pkcs12Algorithm) ?? 'aes256'
  exportDialog.visible = true
}

async function submitExport(): Promise<void> {
  const passwordError = validateP12Password(exportDialog.password)
  if (passwordError) {
    ElMessage.error(passwordError)
    return
  }
  const confirmError = validatePasswordConfirmation(exportDialog.password, exportDialog.confirm)
  if (confirmError) {
    ElMessage.error(confirmError)
    return
  }

  exportDialog.loading = true
  try {
    const result = await exportP12(certificateId, {
      password: exportDialog.password,
      algorithm: exportDialog.algorithm,
      friendlyName: detail.value?.record.name
    })
    downloadBytes(result.der, result.fileName, 'application/x-pkcs12')
    ElMessage.success('P12 已生成并开始下载，请妥善保管密码')
    exportDialog.visible = false
    await load()
  } catch (error) {
    ElMessage.error(`导出 P12 失败：${describeError(error)}`)
    await load()
  } finally {
    exportDialog.loading = false
  }
}
</script>
