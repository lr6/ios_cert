import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AdminLayout from '@/layouts/AdminLayout.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AdminLayout,
    children: [
      { path: '', redirect: '/certificates' },
      {
        path: 'certificates',
        name: 'certificates',
        component: () => import('@/views/CertificatesView.vue'),
        meta: { title: 'iOS 证书管理' }
      },
      {
        path: 'certificates/new',
        name: 'certificate-new',
        component: () => import('@/views/CertificateCreateView.vue'),
        meta: { title: '新建 CSR' }
      },
      {
        path: 'certificates/:id',
        name: 'certificate-detail',
        component: () => import('@/views/CertificateDetailView.vue'),
        meta: { title: '证书详情' }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '设置' }
      }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/certificates' }
]

export const router = createRouter({
  history: createWebHistory(),
  routes
})
