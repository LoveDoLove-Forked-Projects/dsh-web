# Agent Note: 干净 profile 首次安装停在被忽略的构建脚本上，装了但没有挂载

Status: implemented

## Problem

干净 profile 第一次装不上这一族，而且失败的方向恰好是最不容易被发现的：聚合包已经写进 profile 的 `package.json` 与锁文件，`dsh.profile.bundles` 却始终没有这一行，于是 profile 说自己装了一样它并不加载的东西。

用 `dsh plugin --profile <name> add` 装 `@linxin666/dsh-web-all@<version>` 在干净 profile 上以 exit 1 结束，环境是 pnpm 11.9.0 加官方 CLI 0.2.1-rc.3，唯一的诊断信息是 pnpm 自己的那份清单：`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3, cpu-features@0.0.10, ssh2@1.17.0`。这三个包经由聚合包的依赖树进来，而 pnpm 11 不执行 profile 没有批准过的 postinstall 脚本。

挂载之所以被跳过，是因为官方 CLI 只在安装命令 exit 0 之后才回写 profile（`dsh-plugin-manager`，`lib/types/operations.js:499`）。于是 exit 1 留下一个写了一半的 profile：依赖记下了，bundle 行没有，`dsh --dump-config` 里看不到这一行，而重复同一条命令只会复现同一个失败，不会自愈。

官方 CLI 只在 git 源插件失败时提示 `allowBuilds` 这条补救，注册表包既没有提示也没有线索。本仓自己的 `allowBuilds`（`pnpm-workspace.yaml:13`，五项全为 `true`）归开发工作区所有，从不抵达用户 profile。

这个坑比记录它的版本更老，这一点是查到的而不是断言的：[0.4.7 升级矩阵](../../../../docs/archive/2026-10-17-v0.4.7-upgrade-matrix.md) 第 15 行把同样的首次安装失败记为 `pre-existing, not a 0.4.7 regression`，第 110 行留着同一行 `ERR_PNPM_IGNORED_BUILDS`，而已发布的 0.4.9 复现结果一致。

## Decision

0.4.10 记录这条限制，不改安装器。[发布说明](../../../../docs/release-notes/v0.4.10.md) 在中英两个视图各加一条已知限制，写明触发条件、现象、出路，以及这条限制不是本版引入的。

限制归本篇所有，发布说明只做摘要。下面两个候选修法都不在 0.4.10 里，缺陷未修复：它被记录下来了，没有被关掉。

源码、测试、工作区文件与各份 manifest 一律不动。本仓在内部修不了它：拒绝来自 pnpm 的构建脚本批准模型，而留下缺失 bundle 行的回写时机属于官方 CLI。

影响面只在首次安装。干净 profile 受影响。存量 profile 从 0.4.9 更新到 0.4.10 不受影响，因为 0.4.10 相对 0.4.9 没有新增运行时依赖，而依赖未变时重复安装 exit 0；对 registry 上真版本复跑那次全量升级属于发布之后的检查，这里不宣称已经验过。

## Evidence

- 命令与结果：干净 profile 上用 `dsh plugin --profile <name> add` 装 `@linxin666/dsh-web-all@<version>`，pnpm 11.9.0，官方 CLI 0.2.1-rc.3，exit 1，报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3, cpu-features@0.0.10, ssh2@1.17.0`。
- 回写时机：`dsh-plugin-manager` 的 `lib/types/operations.js:499` 只为 exit 0 的安装执行 profile 回写，所以 exit 1 之后依赖记下了、`dsh.profile.bundles` 那一行没有。
- 失败后的实测状态：`--dump-config` 里没有这个家族包的 bundle，同样的输入重复执行安装命令仍是同样的 exit 1。
- 工作区归属：`pnpm-workspace.yaml:13` 开头的 `allowBuilds` 块归开发工作区，用户 profile 有自己的 `pnpm-workspace.yaml`，不在它的覆盖范围内。
- 出路与各自的依据：把这三个名字写进 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds`，以及先用官方 `--from-default-profile web` 重置 profile 再 add，这两条本机实测都能成功挂载；安装时加 `--config.strictDepBuilds=false` 是文档给出的第三条路。
- 既有记录：[0.4.7 升级矩阵](../../../../docs/archive/2026-10-17-v0.4.7-upgrade-matrix.md) 第 15 行与第 110 行，以及对已发布的 0.4.9 复现出的同一失败。

## Impact

- 干净的首次安装受影响：家族装上了却没挂载，而 CLI 输出里没有任何一处点出缺失的 bundle 行。
- 存量 profile 从 0.4.9 更新到 0.4.10 不受影响，因为依赖集合未变，在它之上重复安装 exit 0。
- 手工自救的用户必须改 profile 自己的 `pnpm-workspace.yaml`；开发工作区的批准清单不会随包一起走。
- 这个状态在重试时不自愈，所以停在 exit 1 的用户手里留着一个能解析这个包、却什么都不加载的 profile。

## Candidate fixes

- 由本仓的安装入口写 `allowBuilds`。走我们自己流程的人都不会再踩这个坑，也是唯一能让首次安装无人值守跑通的候选。但它改变安装行为、要写用户拥有的文件，并且需要针对干净 profile 与存量 profile 分别验证，因此不该塞进一次文档改动里。
- 用文档引导用户。没有行为变化，也是 0.4.10 采取的做法，但只帮得到事后去翻文档的人：CLI 在我们任何文档出现在他眼前之前就已经 exit 1 了。

## Alternatives considered

- **在这次改动里直接补安装入口。** 属于推迟而不是否决：记录这条限制的改动只是文档，而一个会写进用户 profile 的安装器需要这份改动不具备的验证。
- **改本仓的 `pnpm-workspace.yaml`。** 否决：它配置的是开发工作区，用户 profile 读自己的文件，这次编辑碰不到它想修的那个失败。
- **不记录。** 否决：这个失败只是一个退出码加一个 `--dump-config` 看不出来的半挂载 profile，用户分不清「没装」和「装了没挂载」，下一个读代码的人还得从头把这条链重新挖一遍。

## Consequences

- 用户在会踩到它的地方就能看到这条限制，0.4.10 发布说明的两个视图各有一条，推理留在本篇。
- 在两个候选修法之一发布之前，干净 profile 在 0.4.10 上仍可复现该失败。
- 以后真要修，得移动这个决策而不是编辑它：已发布状态变了，本篇要么把修复记成一条取代记录，要么被一条带着验证的新记录取代。
- 依赖集合、协议以及所有挂载路径的行为都不变，因为这里除文档之外没有改动任何东西。
