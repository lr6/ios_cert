<template>
  <div class="page">
    <div class="card">
      <h2 class="section-title">加密备份</h2>
      <p class="hint">
        备份文件包含全部证书记录与私钥材料，整份文件使用 <strong>AES-256-GCM</strong> 加密， 密钥由你的备份密码经
        <strong>PBKDF2-SHA256</strong> 派生（60 万次迭代，每次备份随机盐值）。
        备份不依赖本机主密钥，可以在另一台设备或另一个浏览器中恢复。
      </p>
      <p class="hint">密码不会保存在本地，也不会上传；<strong>忘记备份密码将无法恢复该备份文件</strong>。</p>

      <el-form label-width="120px" style="max-width: 520px; margin-top: 12px">
        <el-form-item label="备份密码" required>
          <el-input v-model="backup.password" type="password" show-password placeholder="至少 10 位，请单独保存" />
        </el-form-item>
        <el-form-item label="确认密码" required>
          <el-input v-model="backup.confirm" type="password" show-password placeholder="再次输入" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Download" :loading="backup.loading" @click="doBackup"
            >生成并下载备份文件</el-button
          >
          <span class="hint" style="margin-left: 8px"
            >当前共有 {{ stats.certificates }} 条记录 / {{ stats.keys }} 份私钥</span
          >
        </el-form-item>
      </el-form>
    </div>

    <div class="card">
      <h2 class="section-title">从备份恢复</h2>
      <p class="hint">请选择本工具导出的备份文件（.json），输入当时的备份密码，先预览内容再决定如何恢复。</p>

      <div class="toolbar" style="margin-top: 12px">
        <input
          ref="backupFileRef"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onBackupFileChosen"
        />
        <el-button :icon="FolderOpened" @click="pickBackupFile">选择备份文件</el-button>
        <span class="hint">{{ restore.fileName || '尚未选择文件' }}</span>
      </div>

      <el-form label-width="120px" style="max-width: 520px">
        <el-form-item label="备份密码" required>
          <el-input v-model="restore.password" type="password" show-password placeholder="输入该备份文件的密码" />
        </el-form-item>
        <el-form-item label="恢复方式">
          <el-radio-group v-model="restore.mode" :disabled="!restore.summary">
            <el-radio value="merge">合并（保留现有记录，仅新增）</el-radio>
            <el-radio value="replace">替换（清空本地记录后写入）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-button :loading="restore.loading" :disabled="!restore.content" @click="doInspect">读取并预览</el-button>
          <el-button type="danger" :disabled="!restore.summary" :loading="restore.loading" @click="doRestore"
            >执行恢复</el-button
          >
        </el-form-item>
      </el-form>

      <el-descriptions v-if="restore.summary" :column="2" border size="small" title="备份内容预览">
        <el-descriptions-item label="备份时间">{{ formatDateTime(restore.summary.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="格式版本">
          envelope v{{ restore.summary.envelopeVersion }} / payload v{{ restore.summary.payloadVersion }}
        </el-descriptions-item>
        <el-descriptions-item label="证书记录">{{ restore.summary.certificateCount }} 条</el-descriptions-item>
        <el-descriptions-item label="私钥材料">{{ restore.summary.privateKeyCount }} 份</el-descriptions-item>
        <el-descriptions-item label="含 CER 证书">{{ restore.summary.withCerCount }} 条</el-descriptions-item>
        <el-descriptions-item label="含 CSR">{{ restore.summary.withCsrCount }} 条</el-descriptions-item>
        <el-descriptions-item label="异常记录">{{ restore.summary.inErrorCount }} 条</el-descriptions-item>
        <el-descriptions-item label="示例名称">{{
          restore.summary.sampleNames.join('、') || '—'
        }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="card">
      <h2 class="section-title">本地存储</h2>
      <p class="hint">
        所有证书元信息、加密后的私钥材料都保存在当前浏览器的 IndexedDB 中，不会上传到任何服务器。
        <strong>清除浏览器数据、使用无痕模式或更换设备都会导致本地数据与私钥丢失</strong>，请务必及时导出备份。
      </p>

      <el-descriptions :column="2" border size="small" style="margin-top: 12px">
        <el-descriptions-item label="证书记录数">{{ stats.certificates }}</el-descriptions-item>
        <el-descriptions-item label="私钥材料数">{{ stats.keys }}</el-descriptions-item>
        <el-descriptions-item label="本地主密钥">{{ stats.hasVault ? '已初始化' : '未初始化' }}</el-descriptions-item>
        <el-descriptions-item label="孤立私钥">{{ stats.orphanKeys }}</el-descriptions-item>
        <el-descriptions-item label="占用空间">{{ stats.usage }}</el-descriptions-item>
        <el-descriptions-item label="可用配额">{{ stats.quota }}</el-descriptions-item>
      </el-descriptions>

      <div class="toolbar" style="margin-top: 12px">
        <el-button :icon="Refresh" @click="loadStats">刷新</el-button>
        <el-button v-if="stats.orphanKeys > 0" type="warning" plain @click="cleanOrphanKeys">
          清理 {{ stats.orphanKeys }} 条孤立私钥
        </el-button>
      </div>
    </div>

    <div class="card">
      <h2 class="section-title">安全说明（请务必阅读）</h2>
      <ul class="hint">
        <li>
          私钥以 AES-256-GCM 密文保存在
          IndexedDB；封装密钥是一个<strong>不可导出</strong>的浏览器密钥对象，无法被导出成文件带走。
        </li>
        <li>
          加密保护的是「本地数据文件被随手翻看或误传」这类风险。<strong>如果本站页面被恶意脚本控制（例如浏览器插件注入），密钥仍然可能被读取。</strong>请勿在不可信的设备或浏览器环境下使用。
        </li>
        <li>P12 导出密码、备份密码<strong>不会</strong>保存在本地；忘记后无法恢复，只能重新导出或重新创建证书。</li>
        <li>
          本工具无法验证证书链完整性、证书吊销状态以及 Apple 账号权限，请在 Apple Developer 后台与目标 macOS
          环境中自行确认。
        </li>
        <li>建议把导出的 P12 与备份文件存放在加密磁盘或密码管理器中，避免通过聊天工具、邮件等渠道传输。</li>
      </ul>
    </div>

    <div class="card">
      <h2 class="section-title">危险操作</h2>
      <p class="hint">
        清空操作会删除本机浏览器中保存的全部证书记录与私钥材料。<strong>没有备份的情况下无法恢复</strong>， 已导出的 P12
        文件不受影响。
      </p>
      <div class="toolbar" style="margin-top: 12px">
        <el-checkbox v-model="confirmClear">我已了解风险，确认要清空本地数据</el-checkbox>
        <el-button type="danger" :disabled="!confirmClear" :loading="clearing" @click="clearAll"
          >清空本地数据</el-button
        >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, FolderOpened, Refresh } from '@element-plus/icons-vue'
import type { BackupSummary, RestoreMode } from '@/types/backup'
import { clearAllData, estimateStorage, getDatabase } from '@/services/storage/database'
import { countKeys, deleteKey, findOrphanKeys } from '@/services/storage/key-repository'
import { hasVault } from '@/services/crypto/key-management-service'
import { createBackup, inspectBackup, restoreBackup } from '@/services/backup/backup-service'
import { downloadText, formatDateTime } from '@/utils/file-download'
import { formatBytes, validateBackupPassword, validatePasswordConfirmation } from '@/utils/validation'
import { describeError } from '@/utils/errors'

const stats = reactive({
  certificates: 0,
  keys: 0,
  hasVault: false,
  orphanKeys: 0,
  usage: '—',
  quota: '—'
})

const backup = reactive({ password: '', confirm: '', loading: false })
const restore = reactive({
  fileName: '',
  content: '',
  password: '',
  mode: 'merge' as RestoreMode,
  summary: null as BackupSummary | null,
  loading: false
})

const backupFileRef = ref<HTMLInputElement>()
const confirmClear = ref(false)
const clearing = ref(false)

onMounted(loadStats)

async function loadStats(): Promise<void> {
  try {
    const db = await getDatabase()
    stats.certificates = await db.count('certificates')
    stats.keys = await countKeys()
    stats.hasVault = await hasVault()
    stats.orphanKeys = (await findOrphanKeys()).length

    const estimate = await estimateStorage()
    stats.usage = estimate ? formatBytes(estimate.usage) : '浏览器不支持统计'
    stats.quota = estimate && estimate.quota > 0 ? formatBytes(estimate.quota) : '—'
  } catch (error) {
    ElMessage.error(`读取本地存储信息失败：${describeError(error)}`)
  }
}

async function doBackup(): Promise<void> {
  const passwordError = validateBackupPassword(backup.password)
  if (passwordError) {
    ElMessage.error(passwordError)
    return
  }
  const confirmError = validatePasswordConfirmation(backup.password, backup.confirm)
  if (confirmError) {
    ElMessage.error(confirmError)
    return
  }
  if (stats.certificates === 0) {
    ElMessage.warning('当前没有任何证书记录，无需备份')
    return
  }

  backup.loading = true
  try {
    const result = await createBackup(backup.password)
    downloadText(result.content, result.fileName, 'application/json')
    ElMessage.success(
      `备份已生成并开始下载：${result.summary.certificateCount} 条证书 / ${result.summary.privateKeyCount} 份私钥。请妥善保存密码。`
    )
  } catch (error) {
    ElMessage.error(`生成备份失败：${describeError(error)}`)
  } finally {
    backup.loading = false
  }
}

function pickBackupFile(): void {
  if (backupFileRef.value) {
    backupFileRef.value.value = ''
    backupFileRef.value.click()
  }
}

async function onBackupFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  restore.fileName = file.name
  restore.summary = null
  try {
    restore.content = await file.text()
    ElMessage.success('已读取备份文件，请输入密码后点击「读取并预览」')
  } catch (error) {
    restore.content = ''
    ElMessage.error(`读取备份文件失败：${describeError(error)}`)
  }
}

async function doInspect(): Promise<void> {
  if (!restore.password) {
    ElMessage.error('请输入备份密码')
    return
  }
  restore.loading = true
  try {
    restore.summary = await inspectBackup(restore.content, restore.password)
    ElMessage.success('解密成功，请确认预览内容后再执行恢复')
  } catch (error) {
    restore.summary = null
    ElMessage.error(`读取备份失败：${describeError(error)}`)
  } finally {
    restore.loading = false
  }
}

async function doRestore(): Promise<void> {
  if (!restore.summary) return
  restore.loading = true
  try {
    if (restore.mode === 'replace') {
      await ElMessageBox.confirm(
        `替换模式会先清空本地现有的 ${stats.certificates} 条证书记录与私钥材料，然后写入备份内容。此操作不可撤销，是否继续？`,
        '确认替换本地数据',
        { type: 'warning', confirmButtonText: '确认替换', cancelButtonText: '取消' }
      )
    }

    const result = await restoreBackup(restore.content, restore.password, restore.mode)
    ElMessage.success(
      `恢复完成：新增 ${result.added} 条，跳过 ${result.skipped} 条，删除 ${result.removed} 条，写入私钥 ${result.keyCount} 份`
    )
    restore.summary = null
    restore.content = ''
    restore.password = ''
    restore.fileName = ''
    await loadStats()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(`恢复失败：${describeError(error)}`)
  } finally {
    restore.loading = false
  }
}

async function cleanOrphanKeys(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '孤立私钥指对应证书记录已被删除、但仍留在本地的私钥材料。清理后无法再用于导出 P12，且不可恢复。',
      '清理孤立私钥',
      { type: 'warning', confirmButtonText: '确认清理', cancelButtonText: '取消' }
    )
    const orphans = await findOrphanKeys()
    for (const key of orphans) {
      await deleteKey(key.id)
    }
    ElMessage.success(`已清理 ${orphans.length} 条孤立私钥`)
    await loadStats()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(`清理失败：${describeError(error)}`)
  }
}

async function clearAll(): Promise<void> {
  clearing.value = true
  try {
    await clearAllData()
    ElMessage.success('本地数据已清空')
    confirmClear.value = false
    await loadStats()
  } catch (error) {
    ElMessage.error(`清空失败：${describeError(error)}`)
  } finally {
    clearing.value = false
  }
}
</script>

<style scoped>
ul.hint {
  padding-left: 20px;
  margin: 0;
}

ul.hint li {
  margin-bottom: 6px;
}
</style>
