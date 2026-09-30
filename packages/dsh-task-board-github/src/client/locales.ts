/**
 * GitHub provider extension copy: zh-first dictionary with an English
 * counterpart. The zh side is the key-set source of truth;
 * `packages/dsh-i18n` mirrors the keys into the centralized ru dictionary and
 * `pnpm i18n:check` enforces the parity.
 *
 * The `settings.*` chrome keys are the shared plugin-card vocabulary every
 * family card carries (see shared/client/settings/PluginSettingsCard.tsx).
 */

/** Extension copy, key source of truth. */
export const zh = {
  'settings.title': 'GitHub Issues 同步',
  'settings.description': '任务看板的外部提供方扩展：把 GitHub Issues 同步成看板卡片。默认开启，可在本卡关闭。',
  'settings.enabled': '启用 GitHub Issues 同步',
  'settings.enabledHint': '关闭后本扩展不向任务看板提供服务，GitHub Issues 的同步随之停用；看板本身不受影响。',
  'settings.placeholder': '本阶段只提供总开关：仓库列表、令牌环境变量与同步状态由接入阶段补齐。',
  'settings.on': '开',
  'settings.off': '关',
  'settings.inherit': '继承（跟随部署默认）',
  'settings.overridden': '已覆盖',
  'settings.reset': '重置',
  'settings.invalidValue': '该取值不被接受',
  'settings.notExposed': '当前 DSH 版本未向设置页暴露本插件的配置命名空间，表单不可用。可编辑 ~/.dsh/settings.yaml 直接配置，或将本命名空间加入 Host 设置白名单后重启。',
  'settings.readOnly': '当前部署的设置只读。',
  'settings.expand': '展开设置',
  'settings.collapse': '收起设置',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.discard': '放弃',
  'settings.unsaved': '未保存',
  'settings.saveFailed': '部署未接受这些值，已保留供你修改。',
}

/** English counterpart; the key set mirrors {@link zh} exactly. */
export const en: Record<keyof typeof zh, string> = {
  'settings.title': 'GitHub Issues sync',
  'settings.description': 'External provider extension for the task board: it synchronizes GitHub Issues into board cards. On by default and switchable off from this card.',
  'settings.enabled': 'Enable GitHub Issues sync',
  'settings.enabledHint': 'When off, this extension serves the task board nothing and GitHub Issues synchronization stops; the board itself is unaffected.',
  'settings.placeholder': 'This stage ships the master switch only: the repository list, the token environment variable and the sync status arrive with the provider registration.',
  'settings.on': 'On',
  'settings.off': 'Off',
  'settings.inherit': 'Inherit (deployment default)',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset',
  'settings.invalidValue': 'The value is not accepted',
  'settings.notExposed': "This DSH version does not expose this plugin's settings namespace to the configuration page, so the form is unavailable. Edit ~/.dsh/settings.yaml directly, or add the namespace to the Host settings allowlist and restart.",
  'settings.readOnly': 'This deployment serves settings read-only.',
  'settings.expand': 'Show settings',
  'settings.collapse': 'Hide settings',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.discard': 'Discard',
  'settings.unsaved': 'Unsaved',
  'settings.saveFailed': 'The deployment did not accept these values; they were left for you to correct.',
}

/** Every key in the locale catalog. */
export type TaskBoardGithubKey = keyof typeof zh
