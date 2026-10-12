import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.history/**', '.playwright-mcp/**', 'dev-dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      // 允许未使用的函数参数以 _ 开头（接口占位与忽略参数场景）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // 模板里使用 v-html 会带来 XSS 风险，本项目一律禁止
      'vue/no-v-html': 'error',
      'vue/multi-word-component-names': 'off'
    }
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // 构建/运维脚本运行在 Node 环境
    files: ['scripts/**/*.{js,mjs,cjs}', '*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  prettier
)
