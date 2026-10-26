# Agent Note: 整合的 Web 扩展设置父级

Status: implemented

## 问题

家族设置对话框给每项功能分配一个一级导航行。Web 插件卡、皮肤、宠物、创意工坊和使用统计因此占据五行，尽管这些管理页都属于同一个扩展区域；皮肤、宠物和统计的长页面进一步放大了导航成本。合并这些页面时，不能破坏独立包装载、既有家族卡席位或直接打开使用统计的链接。

## 决策

`dsh-web-settings` 拥有稳定的一级 `settings.section` id `web-ui-plugins`，把它显示为「Web 扩展」，并声明 keyed/root 子槽 `web-ui.extension`。父级按 `web-ui-plugins`、`skin-center`、`pet`、`dsh-workshop`、`dsh-usage` 的固定顺序渲染已安装条目；父级拥有标签文案、可换行的无障碍顶部 tablist，只挂载当前 keyed 页面。Web 插件子项继续声明 `web-ui.plugin.item`，创意工坊子项继续声明 `dsh-workshop.panel`，两套既有扩展生态都不搬迁。

父级发布带 `sectionId`、`label()` 和 `open(id)` 的 `webUiExtensions` 服务。每个内容插件把服务存在与否作为整合判定，监听 `slots/changed`，让唯一一条注册在 `web-ui.extension` 与原一级分区之间迁移。注册还会等待目标槽声明，避免服务发布与声明之间的间隙或声明坍缩造成拒绝注册的重试循环。keyed 条目只携带 `key`、locale 和业务面；list 专用的 id、order、label 仅保留在独立注册上。表单控制器归插件 apply 生命周期而非席位，因此迁移不会重置草稿或订阅。`open(id)` 先选中目标 TAB，再用稳定父级 id 调用原生设置 store；原生导航不可用时，使用统计速览卡保留携带父级 id 与标签的 DOM 重放兜底。

统计页采用摘要与趋势网格，皮肤页把皮肤库与背景控制并排，宠物页把可视化宠物选择与分组字段并排；窄容器都降为单列。这些页面上的小型 N 选 1 使用带 `aria-pressed` 的可见分段组；共享设置字段以显式选项提供该呈现，其他插件卡片仍保留紧凑下拉。语义插件根标识当前页面供皮肤补丁使用。一级 `nth-child` 选择器不是受支持的锚点，因为无关插件也会增删导航行。

## 备选方案

- 保留独立一级页面，只调整内容样式。否决：这既不能减少导航增长，也没有形成用户要求的共享扩展层级。
- 不设服务门禁与回退，让所有功能永久注册到新父级。否决：父级包缺席时，独立安装的皮肤、宠物、创意工坊和统计会失去设置入口。
- 把既有家族插件卡或工坊资产面板也迁入新的 keyed 槽。否决：这些席位有各自的属主与声明生命周期；保持原位可避免迁移无关贡献者。
- 保留按位置绘制导航图标和插画。否决：真实设置导航还包含第三方分区，位置不能标识功能。父级使用原生后备图标，页面皮肤装饰改由语义面板根驱动。

## 后果

- 完整家族安装只暴露一个「Web 扩展」一级入口和五个二级 TAB；父级缺席时，各内容包保留原一级入口和 id。
- 既有 `web-ui-plugins` 深链保持有效。使用统计导航还会先选中自己的 TAB 再打开该分区，包括 DOM 兜底前保留的待选状态。
- 只有当前 keyed 页面轮询或渲染详细内容。席位切换先释放旧注册再创建替代注册，并用重入门闩吸收同步槽位事件。
- `packages/dsh-web-settings/tests/web-extensions-section.spec.tsx`、`web-ui-extensions.spec.ts`、`packages/dsh-market/tests/extension-seat.spec.ts`、`packages/dsh-usage/tests/section-integration.spec.ts` 与两个卫星仓席位测试固定 TAB 行为、深链顺序和独立/整合迁移。
- 真实 GUI 的桌面与窄视口证据归本改动的交付报告。
