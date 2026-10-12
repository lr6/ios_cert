<template>
  <el-container class="admin-layout">
    <el-header class="admin-header">
      <div class="brand">
        <span class="brand-mark">iOS</span>
        <span class="brand-title">iOS 证书管理工具</span>
        <span class="brand-sub">本地生成 CSR · 导入 CER · 导出 P12</span>
      </div>
    </el-header>

    <el-container>
      <el-aside width="200px" class="admin-aside">
        <el-menu :default-active="activeMenu" router>
          <el-menu-item index="/certificates">
            <el-icon><Tickets /></el-icon>
            <span>iOS 证书管理</span>
          </el-menu-item>
          <el-menu-item index="/settings">
            <el-icon><Setting /></el-icon>
            <span>设置与本地数据</span>
          </el-menu-item>
        </el-menu>
      </el-aside>

      <el-main class="admin-main">
        <el-breadcrumb separator="/" class="admin-breadcrumb">
          <el-breadcrumb-item>网站导航</el-breadcrumb-item>
          <el-breadcrumb-item>后台管理</el-breadcrumb-item>
          <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
        </el-breadcrumb>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Setting, Tickets } from '@element-plus/icons-vue'

const route = useRoute()

const activeMenu = computed(() => {
  if (route.path.startsWith('/settings')) return '/settings'
  return '/certificates'
})

const currentTitle = computed(() => {
  if (route.path.startsWith('/settings')) return '本地存储与安全设置'
  if (route.path.startsWith('/certificates/new')) return '新建 CSR'
  if (route.path.startsWith('/certificates/')) return '证书详情'
  return 'iOS 证书管理'
})
</script>

<style scoped>
.admin-layout {
  min-height: 100vh;
}

.admin-header {
  background: #fff;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  height: 60px;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand-mark {
  background: var(--primary);
  color: #fff;
  font-weight: 700;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 13px;
}

.brand-title {
  font-size: 17px;
  font-weight: 600;
}

.brand-sub {
  color: var(--text-sub);
  font-size: 12px;
}

.admin-aside {
  background: #fff;
  border-right: 1px solid var(--border);
  min-height: calc(100vh - 60px);
}

.admin-aside :deep(.el-menu) {
  border-right: none;
}

.admin-main {
  padding: 0;
  background: var(--page-bg);
}

.admin-breadcrumb {
  padding: 12px 16px 0;
}

@media (max-width: 768px) {
  .admin-aside {
    width: 64px !important;
  }
  .admin-aside :deep(.el-menu-item span) {
    display: none;
  }
  .brand-sub {
    display: none;
  }
}
</style>
