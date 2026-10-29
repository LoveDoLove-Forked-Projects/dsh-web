/**
 * Copy of the team provider's browser half.
 *
 * The Chinese dictionary is the key source: every other locale tracks exactly
 * these keys (the repository gate enforces parity), and no user-facing string is
 * written inline in a component. The third language is carried centrally by
 * dsh-i18n, which is why this module ships zh and en only.
 *
 * @module dsh-task-board-team/client/locales
 */

export const zh = {
  'section.title': '团队协作',
  'section.hub': 'Hub 地址',
  'section.team': '团队 ID',
  'section.token': 'Host Token',
  'section.token.configured': '已配置（保存在宿主侧，不回显）',
  'section.token.missing': '未配置',
  'section.token.placeholder': '粘贴 Host Token，保存后只在宿主侧使用',
  'section.token.save': '保存 Token',
  'section.token.clear': '清除 Token',
  'section.agents': '团队 Agent 绑定',
  'section.agents.empty': '尚未绑定任何 dsh-agents 成员，本机不会领取任何团队任务',
  'section.agents.hint': '填写 dsh-agents 的成员 ID，用逗号分隔',
  'section.questionWait': '本地兜底等待（分钟）',
  'section.questionWait.hint': '0 = 不设本地上限，一直等到 hub 给出终态（回答、过期或撤回）',
  'section.save': '保存设置',
  'section.saved': '已保存',
  'section.refresh': '立即领取',
  'section.connection': '连接状态',
  'section.connection.idle': '未启动',
  'section.connection.connecting': '正在注册',
  'section.connection.online': '在线',
  'section.connection.reconnecting': '正在重连',
  'section.connection.error': '连接失败',
  'section.host': '主机',
  'section.heartbeat': '最近心跳',
  'section.reconnects': '重连次数',
  'section.capabilities': '能力',
  'section.capability.followUp': '后续消息投递',
  'section.capability.rework': '同会话返工',
  'section.capability.run': '自动开始执行',
  'section.capability.available': '可用',
  'section.capability.missing': '不可用',
  'section.capability.followUpMissing': '当前看板版本不提供 followUp，评论里 @ 本机 Agent 时只能记在活动流里',
  'section.capability.reworkMissing': '当前看板版本不提供 rework，收到返工请求时只记录，不会重跑',
  'section.capability.runMissing': '当前看板版本不提供执行入口，领取到的卡片需要人工在看板上开始',
  'section.capability.presetPin': '建卡时钉住预设与模型',
  'section.capability.presetPinMissing': '当前看板版本无法在建卡时钉住 Agent 预设、模型与思考档位，因此领取到的镜像卡没有启动，需要人工处理',
  'section.problems': '配置问题',
  'detail.title': '团队协作',
  'detail.issue': '团队 issue',
  'detail.assignee': '负责人',
  'detail.reviewer': '审阅人',
  'detail.agent': '执行 Agent',
  'detail.status': 'Hub 状态',
  'detail.comments': '评论',
  'detail.activity': '活动',
  'detail.pending': '待回答的问题',
  'detail.empty': '暂无',
  'detail.error': '最近错误',
  'status.todo': '待办',
  'status.assigned': '已分配',
  'status.waiting_host': '等待执行节点',
  'status.running': '执行中',
  'status.in_review': '待审阅',
  'status.done': '已完成',
  'status.canceled': '已取消',
  'status.failed': '失败',
  'unavailable': '本扩展的团队配置尚不可用',
} as const

export type TeamKey = keyof typeof zh

export const en: Record<TeamKey, string> = {
  'section.title': 'Team collaboration',
  'section.hub': 'Hub URL',
  'section.team': 'Team ID',
  'section.token': 'Host Token',
  'section.token.configured': 'Configured (kept host-side, never echoed)',
  'section.token.missing': 'Not configured',
  'section.token.placeholder': 'Paste the Host Token; it is used host-side only',
  'section.token.save': 'Save token',
  'section.token.clear': 'Clear token',
  'section.agents': 'Team Agent bindings',
  'section.agents.empty': 'No dsh-agents member is bound, so this machine claims nothing',
  'section.agents.hint': 'dsh-agents member ids, separated by commas',
  'section.questionWait': 'Local fallback wait (minutes)',
  'section.questionWait.hint': '0 = no local cap; wait for the hub to settle the question (answered, expired or withdrawn)',
  'section.save': 'Save settings',
  'section.saved': 'Saved',
  'section.refresh': 'Claim now',
  'section.connection': 'Connection',
  'section.connection.idle': 'Stopped',
  'section.connection.connecting': 'Registering',
  'section.connection.online': 'Online',
  'section.connection.reconnecting': 'Reconnecting',
  'section.connection.error': 'Connection failed',
  'section.host': 'Host',
  'section.heartbeat': 'Last heartbeat',
  'section.reconnects': 'Reconnects',
  'section.capabilities': 'Capabilities',
  'section.capability.followUp': 'Follow-up delivery',
  'section.capability.rework': 'Rework in session',
  'section.capability.run': 'Start executions',
  'section.capability.available': 'Available',
  'section.capability.missing': 'Unavailable',
  'section.capability.followUpMissing': 'This board revision serves no followUp, so a mention is only recorded on the activity stream',
  'section.capability.reworkMissing': 'This board revision serves no rework, so a rework request is recorded and never re-run',
  'section.capability.runMissing': 'This board revision serves no execution entry, so a claimed card has to be started on the board',
  'section.capability.presetPin': 'Pinning a preset and model on create',
  'section.capability.presetPinMissing': 'This board revision cannot pin an agent preset, model or reasoning effort when creating a card, so the mirror card was not started and needs a human',
  'section.problems': 'Configuration problems',
  'detail.title': 'Team collaboration',
  'detail.issue': 'Team issue',
  'detail.assignee': 'Assignee',
  'detail.reviewer': 'Reviewer',
  'detail.agent': 'Executing agent',
  'detail.status': 'Hub status',
  'detail.comments': 'Comments',
  'detail.activity': 'Activity',
  'detail.pending': 'Open questions',
  'detail.empty': 'Nothing yet',
  'detail.error': 'Last error',
  'status.todo': 'Todo',
  'status.assigned': 'Assigned',
  'status.waiting_host': 'Waiting for the execution node',
  'status.running': 'Running',
  'status.in_review': 'In review',
  'status.done': 'Done',
  'status.canceled': 'Canceled',
  'status.failed': 'Failed',
  'unavailable': 'The team configuration of this extension is not available',
}

/** The translate seat the seats use when the client locale service is absent. */
let translate: (key: TeamKey) => string = key => zh[key]

/**
 * Install the runtime translate seat.
 * @param bound - the locale-bound lookup of this namespace.
 */
export function setRuntimeTranslate(bound: (key: TeamKey) => string): void {
  translate = bound
}

/**
 * Translate one key of this namespace.
 * @param key - dictionary key.
 * @returns the localized string.
 */
export function t(key: TeamKey): string {
  return translate(key)
}