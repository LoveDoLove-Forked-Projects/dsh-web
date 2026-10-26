/**
 * The `web-ui-plugins` locale dictionaries for the Web Extensions section.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': 'Web 插件',
  'extensions.title': 'Web 扩展',
  'extensions.navigation': 'Web 扩展页面',
  'extensions.repository': '在 GitHub 上打开 dsh-web',
  'extensions.unavailable': '这个页面暂时不可用。',
  'extensions.tab.skin-center': '皮肤',
  'extensions.tab.pet': '宠物',
  'extensions.tab.dsh-workshop': '创意工坊',
  'extensions.tab.dsh-usage': '使用统计',
  'group.general': '通用',
  'group.plugins': '插件',
  'telemetry.title': '匿名安装遥测',
  'telemetry.description': '每天发送一次匿名心跳，列出本机在用的家族插件。关闭后所有家族插件都不再发送，创意工坊与在线更新照常工作。',
  'telemetry.dnt': '浏览器开启了「请勿跟踪」，心跳已经停止；开关只记录本机的偏好。',
  'settings.collapse': '收起',
  'settings.expand': '展开',
  'settings.notExposed': '该设置段未暴露（宿主命名空间缺失）',
  'settings.readOnly': '只读',
  'settings.saveFailed': '保存失败',
} satisfies Record<string, string>

/** Key union for this namespace. */
export type WebUIPluginsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Web Plugins',
  'extensions.title': 'Web Extensions',
  'extensions.navigation': 'Web Extensions pages',
  'extensions.repository': 'Open dsh-web on GitHub',
  'extensions.unavailable': 'This page is unavailable right now.',
  'extensions.tab.skin-center': 'Skins',
  'extensions.tab.pet': 'Pet',
  'extensions.tab.dsh-workshop': 'Workshop',
  'extensions.tab.dsh-usage': 'Usage',
  'group.general': 'General',
  'group.plugins': 'Plugins',
  'telemetry.title': 'Anonymous install telemetry',
  'telemetry.description': 'One anonymous heartbeat a day, listing the family plugins in use here. Off stops every family plugin from sending it; the Workshop and online updates keep working.',
  'telemetry.dnt': 'This browser asks not to be tracked, so the heartbeat has stopped; the switch only records the preference on this machine.',
  'settings.collapse': 'Collapse',
  'settings.expand': 'Expand',
  'settings.notExposed': 'Section not exposed (host namespace missing)',
  'settings.readOnly': 'Read only',
  'settings.saveFailed': 'Save failed',
} satisfies Record<WebUIPluginsKey, string>
