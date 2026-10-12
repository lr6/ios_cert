<template>
  <div class="page">
    <div class="card">
      <div class="toolbar">
        <div>
          <h2 class="section-title">iOS 证书管理</h2>
          <p class="hint">
            在这里完成 iOS 开发/发布证书的本地管理：<strong
              >生成 CSR → 到 Apple Developer 后台上传 CSR 并创建证书 → 下载 CER → 回到本页导入 CER → 导出 P12</strong
            >。 私钥、CSR、CER、P12 与密码全程只在你的浏览器本地处理，不会上传到任何服务器。
          </p>
          <p class="hint">
            本工具<strong>不会</strong>自动登录 Apple Developer，也不会代你创建证书；从「下载 CSR」到「拿到
            CER」之间的步骤需要你在 Apple 后台手动完成。
          </p>
        </div>
        <div class="spacer"></div>
        <el-button type="primary" :icon="Plus" @click="router.push('/certificates/new')">新建 CSR 文件</el-button>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <el-input
          v-model="search"
          placeholder="搜索证书名称"
          clearable
          style="width: 220px"
          :prefix-icon="Search"
          @keyup.enter="applyFilter"
          @clear="applyFilter"
        />
        <el-select v-model="status" style="width: 160px" @change="applyFilter">
          <el-option label="全部状态" value="all" />
          <el-option
            v-for="(label, value) in CERTIFICATE_STATUS_LABELS"
            :key="value"
            :label="`${label} (${counts[value] ?? 0})`"
            :value="value"
          />
        </el-select>
        <el-button :icon="Refresh" @click="reload">刷新</el-button>
        <div class="spacer"></div>
        <span class="hint">共 {{ total }} 条记录</span>
      </div>

      <el-table v-loading="loading" :data="records" border stripe style="width: 100%">
        <el-table-column prop="name" label="证书名称" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <router-link :to="`/certificates/${row.id}`">{{ row.name }}</router-link>
            <el-tag v-if="row.lastError" type="danger" size="small" effect="plain" style="margin-left: 6px"
              >有错误</el-tag
            >
          </template>
        </el-table-column>

        <el-table-column label="证书类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.purpose === 'distribution' ? 'warning' : 'primary'" effect="plain">
              {{ CERTIFICATE_PURPOSE_LABELS[row.purpose as CertificatePurpose] }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="CSR 文件" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.csrPem" size="small" type="success" effect="plain">已生成</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未生成</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="CER 文件" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.cerPem" size="small" type="success" effect="plain">已导入</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未导入</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="P12 状态" width="160">
          <template #default="{ row }">
            <el-tag size="small" :type="p12State(row).type" effect="plain">{{ p12State(row).text }}</el-tag>
            <div v-if="row.p12ExportedAt" class="hint">最近 {{ formatDate(row.p12ExportedAt) }}</div>
          </template>
        </el-table-column>

        <el-table-column label="证书有效期" width="200">
          <template #default="{ row }">
            <span v-if="row.cerInfo"
              >{{ formatDate(row.cerInfo.notBefore) }} ~ {{ formatDate(row.cerInfo.notAfter) }}</span
            >
            <span v-else class="hint">—</span>
            <div v-if="row.cerInfo" class="hint">
              <el-tag v-if="row.cerInfo.expired" type="danger" size="small" effect="dark">已过期</el-tag>
              <el-tag v-else-if="row.cerInfo.notYetValid" type="warning" size="small" effect="dark">尚未生效</el-tag>
              <span v-else>{{ daysLeft(row.cerInfo.notAfter) }} 天后过期</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="更新时间" width="140">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>

        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="router.push(`/certificates/${row.id}`)">详情</el-button>
            <el-dropdown trigger="click" @command="(command: RowCommand) => handleRowCommand(command, row)">
              <el-button link type="primary" size="small">
                更多<el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="csr" :disabled="!row.csrPem">下载 CSR</el-dropdown-item>
                  <el-dropdown-item command="cer">导入 CER</el-dropdown-item>
                  <el-dropdown-item command="p12">导出 P12</el-dropdown-item>
                  <el-dropdown-item command="rename" divided>修改名称</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除记录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty-block">
            <p>还没有任何证书记录。</p>
            <p class="hint">
              点击「新建 CSR 文件」开始：输入证书名称 → 选择用途 → 生成 CSR 并下载 → 到 Apple Developer 后台创建证书。
            </p>
            <el-button type="primary" @click="router.push('/certificates/new')">新建 CSR 文件</el-button>
          </div>
        </template>
      </el-table>

      <el-pagination
        v-if="total > 0"
        style="margin-top: 12px; justify-content: flex-end"
        layout="total, sizes, prev, pager, next"
        :total="total"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="[10, 20, 50]"
        @current-change="onPageChange"
        @size-change="onPageSizeChange"
      />
    </div>

    <input
      ref="fileInputRef"
      type="file"
      accept=".cer,.crt,.pem,.der"
      style="display: none"
      @change="onCerFileChosen"
    />

    <el-dialog v-model="exportDialog.visible" title="导出 P12" width="520px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="P12 导出密码用于保护私钥，请务必记牢并单独保存"
        description="密码不会保存在本地，忘记后只能重新导出。导出文件包含证书与私钥，请勿通过不安全渠道传输。"
        style="margin-bottom: 12px"
      />
      <el-form label-width="120px">
        <el-form-item label="证书">
          <span class="mono">{{ exportDialog.name }}</span>
        </el-form-item>
        <el-form-item label="密钥加密算法">
          <el-select v-model="exportDialog.algorithm" style="width: 100%">
            <el-option label="AES-256-CBC (PBES2，推荐)" value="aes256" />
            <el-option label="3DES (兼容模式：旧工具链 / HBuilderX 等云打包)" value="3des" />
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

    <el-dialog v-model="deleteDialog.visible" title="删除证书记录" width="480px">
      <p>
        将删除记录：<strong>{{ deleteDialog.name }}</strong>
      </p>
      <el-checkbox v-model="deleteDialog.deleteKeyMaterial">
        同时删除本地私钥材料（删除后无法再导出 P12，且不可恢复）
      </el-checkbox>
      <template #footer>
        <el-button @click="deleteDialog.visible = false">取消</el-button>
        <el-button type="danger" :loading="deleteDialog.loading" @click="confirmDelete">确认删除</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  CERTIFICATE_PURPOSE_LABELS,
  CERTIFICATE_STATUS_LABELS,
  type CertificatePurpose,
  type CertificateStatus
} from '@/types/certificate'
import type { CertificateRecord } from '@/types/record'
import { countByStatus, deleteCertificateCascade, listCertificates } from '@/services/storage/certificate-repository'
import { exportP12, importCer, renameCertificate } from '@/services/certificates/certificate-service'
import type { Pkcs12Algorithm } from '@/services/certificates/pkcs12-service'
import { downloadBytes, downloadText, formatDate, formatDateTime, readFileBytes } from '@/utils/file-download'
import { describeError } from '@/utils/errors'
import {
  sanitizeFileName,
  validateCerFileSize,
  validatePasswordConfirmation,
  validateP12Password
} from '@/utils/validation'

const router = useRouter()

const loading = ref(false)
const records = ref<CertificateRecord[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const search = ref('')
const status = ref<CertificateStatus | 'all'>('all')
const counts = ref<Record<string, number>>({ all: 0 })

const fileInputRef = ref<HTMLInputElement>()
let importTargetId: string | null = null

const exportDialog = reactive({
  visible: false,
  id: '',
  name: '',
  password: '',
  confirm: '',
  algorithm: 'aes256' as Pkcs12Algorithm,
  loading: false
})

const deleteDialog = reactive({
  visible: false,
  id: '',
  name: '',
  deleteKeyMaterial: true,
  loading: false
})

onMounted(reload)

async function reload(): Promise<void> {
  loading.value = true
  try {
    const result = await listCertificates({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value,
      status: status.value
    })
    records.value = result.items
    total.value = result.total
    counts.value = await countByStatus()
  } catch (error) {
    ElMessage.error(`读取本地数据失败：${describeError(error)}`)
  } finally {
    loading.value = false
  }
}

function applyFilter(): void {
  page.value = 1
  void reload()
}

function onPageChange(next: number): void {
  page.value = next
  void reload()
}

function onPageSizeChange(size: number): void {
  pageSize.value = size
  page.value = 1
  void reload()
}

type RowCommand = 'csr' | 'cer' | 'p12' | 'rename' | 'delete'

function handleRowCommand(command: RowCommand, record: CertificateRecord): void {
  switch (command) {
    case 'csr':
      downloadCsr(record)
      break
    case 'cer':
      pickCerFile(record.id)
      break
    case 'p12':
      openExportDialog(record)
      break
    case 'rename':
      void rename(record)
      break
    case 'delete':
      openDeleteDialog(record)
      break
  }
}

function p12State(record: CertificateRecord): { text: string; type: 'success' | 'primary' | 'danger' | 'info' } {
  if (record.p12ExportedAt) {
    return { text: '已导出', type: 'success' }
  }
  if (record.status === 'ready') return { text: '可导出', type: 'primary' }
  if (record.status === 'error') return { text: '不可导出', type: 'danger' }
  if (!record.cerPem) return { text: '待导入 CER', type: 'info' }
  return { text: '待校验', type: 'info' }
}

function daysLeft(notAfter: string): number {
  return Math.max(0, Math.ceil((new Date(notAfter).getTime() - Date.now()) / 86_400_000))
}

function downloadCsr(record: CertificateRecord): void {
  if (!record.csrPem) return
  downloadText(record.csrPem, `${sanitizeFileName(record.name)}.certSigningRequest`, 'text/plain;charset=utf-8')
}

function pickCerFile(id: string): void {
  importTargetId = id
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
    fileInputRef.value.click()
  }
}

async function onCerFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const targetId = importTargetId
  if (!file || !targetId) return

  const sizeError = validateCerFileSize(file.size)
  if (sizeError) {
    ElMessage.error(sizeError)
    return
  }

  loading.value = true
  try {
    const data = await readFileBytes(file)
    const result = await importCer(targetId, { data, fileName: file.name })
    if (result.matchesPrivateKey) {
      ElMessage.success(`已导入证书，并确认与本地私钥匹配（${result.record.cerInfo?.subjectCommonName ?? file.name}）`)
    } else {
      ElMessage.error(`证书已保存，但校验失败：${result.message}`)
    }
    await reload()
  } catch (error) {
    ElMessage.error(`导入 CER 失败：${describeError(error)}`)
  } finally {
    loading.value = false
    importTargetId = null
  }
}

function openExportDialog(record: CertificateRecord): void {
  if (!record.cerPem) {
    ElMessage.warning('请先导入 Apple 颁发的 CER 证书，再导出 P12')
    return
  }
  exportDialog.id = record.id
  exportDialog.name = record.name
  exportDialog.password = ''
  exportDialog.confirm = ''
  exportDialog.algorithm = (record.p12Algorithm as Pkcs12Algorithm) ?? 'aes256'
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
    const result = await exportP12(exportDialog.id, {
      password: exportDialog.password,
      algorithm: exportDialog.algorithm,
      friendlyName: exportDialog.name
    })
    downloadBytes(result.der, result.fileName, 'application/x-pkcs12')
    ElMessage.success('P12 已生成并开始下载，请妥善保管密码')
    exportDialog.visible = false
    await reload()
  } catch (error) {
    ElMessage.error(`导出 P12 失败：${describeError(error)}`)
  } finally {
    exportDialog.loading = false
  }
}

async function rename(record: CertificateRecord): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请输入新的证书名称', '修改证书名称', {
      inputValue: record.name,
      inputValidator: (input) => (input && input.trim() ? true : '证书名称不能为空'),
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    })
    await renameCertificate(record.id, value)
    ElMessage.success('名称已更新（不会修改已生成的 CSR / 证书内容）')
    await reload()
  } catch (error) {
    if (isCancelled(error)) return
    ElMessage.error(`修改名称失败：${describeError(error)}`)
  }
}

function openDeleteDialog(record: CertificateRecord): void {
  deleteDialog.id = record.id
  deleteDialog.name = record.name
  deleteDialog.deleteKeyMaterial = true
  deleteDialog.visible = true
}

async function confirmDelete(): Promise<void> {
  deleteDialog.loading = true
  try {
    await deleteCertificateCascade(deleteDialog.id, { deleteKeyMaterial: deleteDialog.deleteKeyMaterial })
    ElMessage.success('记录已删除')
    deleteDialog.visible = false
    await reload()
  } catch (error) {
    ElMessage.error(`删除失败：${describeError(error)}`)
  } finally {
    deleteDialog.loading = false
  }
}

/** 兼容 Element Plus 取消时的特殊返回值 */
function isCancelled(error: unknown): boolean {
  return error === 'cancel' || error === 'close' || (error as { message?: string })?.message === 'cancel'
}
</script>

<style scoped>
.nowrap {
  white-space: nowrap;
}

.empty-block {
  padding: 24px 0;
  text-align: center;
}
</style>
