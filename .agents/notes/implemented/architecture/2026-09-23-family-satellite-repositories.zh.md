# Agent Note: 家族卫星仓库与 npm 消费

Status: implemented

## 问题

皮肤中心、宠物插件与社区插件索引此前都维护在本单一仓库里，市场构建直接按 `packages/` 路径读取它们的资产。这带来三项代价。

皮肤贡献者要对着聚合仓库开 PR：一个新皮肤淹没在十六个插件包之间，评审路由与插件评审混在一起，而且资产只能搭下一次家族发布的顺风车才分发出去。宠物资产形状相同，体量 197 MB。社区索引——决定创意工坊列出哪些第三方插件的那个文件——与消费它的商店同处一仓，于是一行索引更新要等整条插件发布链。

但这三个插件在代码上并不耦合：它们从不互相导入，也不导入任何兄弟包，家族共享运行时模块早就通过 `scripts/sync-shared.mjs` 生成的已提交副本抵达它们。把它们绑在本仓的是工具链与产物链，不是源码。

## 决策

三个插件在各自仓库维护，在本仓按已发布的 npm 包消费：

- `@linxin666/dsh-client-ui-skin-center` —— [dsh-skins](https://github.com/zhu1090093659/dsh-skins)，同时承载 42 个皮肤资产与皮肤投稿入口；
- `@linxin666/dsh-pet` —— [dsh-pet](https://github.com/zhu1090093659/dsh-pet)，承载插件与全部宠物资产；
- `@linxin666/dsh-client-ui-community-plugins` —— [dsh-community-plugins](https://github.com/zhu1090093659/dsh-community-plugins)，承载 `community.json`。

包名保持不变，消费方仍解析同一批 specifier。

聚合包改用 `rows:`（外部 npm 行）加显式 semver 范围挂载它们，不再走 `patchFrom`/`deps`；`packages/dsh-web-all/package.json` 手写这三条依赖。行 id 与 `patchFrom` 时期逐字一致（`web-ui-pet`、`web-ui-skin-center`、`web-ui-community-plugins`），既有 profile 无需迁移。这些行原先挂载用的子路径导出（`./pet`、`./skin-center`、`./community-plugins`）以 `tombstones:` 保留在 exports 表里，因此记录了 `@linxin666/dsh-web-all/pet` 的 profile 仍可 import，而不会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

### 外部行用容错隔离换独立性

外部行直接挂载真实包名：它没有 `config.plugin`，不被聚合包的 fault-isolation shell 包装，浏览器半区也不再内联进聚合包的 client bundle。壳存在的意义是让单个坏掉的家族插件拖不垮整个启动，这三行放弃了这一点。换回来的是：它们的浏览器半区由 loader 从各自的 loader entry 挂载，它们的源码改动不再强制重建 `dsh-web-all/lib`；新契约记录在 `packages/dsh-web-all/AGENTS.md`。

`tests/satellite-rows.spec.ts` 固化让这次交换安全的那些不变量：行 id、直接挂载（无 `config.plugin`）、声明的 semver 范围、`scripts/aggregate.mjs` 解析外部行所依赖的 `./package.json` 导出、保留的兼容 tombstones、`remote-web-ui` 排在 `pet` 之前的顺序，以及三者已不在 client-children 列表里。

### 市场内容按提交固定

市场构建不再从工作树读皮肤或宠物资产，也不从工作树读社区索引。`market-inputs.lock.json` 记录每个内容仓与要读的提交，`scripts/market-fetch-inputs.mjs` 只解包该提交的内容目录到 `.market-inputs/`（幂等；`--check` 只校验不下载；缺失或过期直接让运行失败），`scripts/market-build` 从那里读取。社区索引同样按提交固定，而不是"npm 解析到什么算什么"：在固定它之前，删掉仓内包会让构建静默读到一份陈旧的已发布索引，产出与已提交 `market/dist` 不再一致的 `manifest/plugins.json`。

`scripts/market-verify-assets.mjs` 走遍生成清单承诺的每个路径，对 `market/dist` 或已部署站点校验，并把服务端字节数与本地文件比对。它必须用 Range GET 而不是 HEAD——Workers 静态资产层对 HEAD 返回 `content-length: 0`。部署流程在 `market:check` 之前拉取，部署之后再对 `dsh-market.com` 校验。这条走查从云厂商 IP 段发出时，突发请求的一部分会被 Cloudflare 以 403 挡下直到其速率窗口重置，因此突发内部先重试这些状态，突发结束后再把仍然失败的路径逐条重核：门禁仍然只报告站点会重复给出的结论，而纯由突发造成、站点其实在服务的状态不再让车道变红。

### 发布顺序

卫星先发版，本仓才切换，因为聚合包把它们作为 npm 外部行挂载，而挂载冒烟断言的是 registry 路径。`@linxin666/dsh-web-all` 以 semver 范围依赖三个卫星包，每个卫星保有自己的版本线：`0.3.25` 携带移除已退役 `settingsScope` 注入的 0.1.7-rc.1 迁移，因此聚合包的挂载冒烟（`scripts/e2e-mount.sh`）在 registry 路径上是绿的，而它的 `FAMILY_TGZS_DIR` 覆盖目录只覆盖本仓构建的包。

## 备选方案

**由本仓生成镜像仓库。** 把三个目录只读镜像到各自的 GitHub 仓，本仓仍是唯一事实源。运营成本最低，也满足"可发现"的目标，但输在贡献目标：镜像上的 PR 无处落地，皮肤投稿仍会回到本仓，镜像只是装饰。

**在当前路径挂 git submodule。** 把三个包以子模块留在 workspace 里，聚合包与市场构建原样可用。否决原因是聚合包的目标是消费已发布包而非工作树：子模块会保留 workspace 链接、客户端内联与重建耦合，还给每个贡献者 clone 增加 detached HEAD 的摩擦。

**只抽出资产、插件留在本仓。** 把皮肤与宠物资产搬到内容仓，插件留下。否决原因是插件与其内容共享契约（`skin.json`、`pet.json` v2）和测试套件；拆到两个仓会把校验放在它所校验之物之外。

**把共享构建预设与运行时模块发布成包。** 让卫星依赖已发布的 `shared/`，而不是各自携带 vendored 副本与自己的 `shared/tsdown.client.ts`。本次否决：仓库当初特意选择提交副本，让每个包在 typecheck、test 与 publish 上自包含，反转该策略本身是一个有自身影响面的决定。卫星携带预设与副本，漂移在代价低的地方检查。

**留在本仓，靠 CODEOWNERS 与标签解决。** 最省事，且解决了评审路由，但没解决分发：贡献者仍要 fork 并 clone 一个 monorepo 才能加一个皮肤，统一家族版本仍卡着每一次皮肤发布。

## 后果

- 三个仓各自拥有 CI、版本线与贡献流程；本仓发布不再发布它们，`release.yml` 与 `scripts/lib/family-packages.mjs` 看到的是十六个包而不是十九个。
- 三行失去聚合包的 fault-isolation shell，它们在插件清单里的标题从 `web-all/<family>` 变成各自的包名。
- SDK cohort 现在要在四个仓推进而不是一个；本次拆分后卫星已同步到 `0.1.7-rc.1`，将来一次 cohort 迁移要碰四个仓。
- 市场站的内容跟随 `market-inputs.lock.json`：一次合并的皮肤或宠物改动，在维护者 bump pin、部署流程重建并重新校验之后才到达 `dsh-market.com`，而不是卫星一合并就到。
- `.market-inputs/` 是拉取来的构建输入（git-ignored），test-standards 与 emoji 审计会跳过它，避免把拉来的第三方内容当作一方代码审计。
- 卫星各自携带一份 `shared/tsdown.client.ts` 与 vendored `shared/` 模块；`scripts/sync-shared.mjs` 现在覆盖 99 份副本而不是 114 份，且不再触达三者。
