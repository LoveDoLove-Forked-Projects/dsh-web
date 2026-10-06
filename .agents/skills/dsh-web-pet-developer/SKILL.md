---
name: dsh-web-pet-developer
description: Create a pet for the dsh-pet plugin in the dsh-pet repository, and submit it there — pet assets live under assets/<id>/ and the contracts are owned by dsh-pet (contracts/pet-manifest-v2.schema.json for the sprite2d / live2d / frames2d renderers with the src/manifest-v2.ts validator, plus the voice-pack and status-decoration contracts); validate with the repository's scripts/dsh-pet.cjs CLI plus pnpm typecheck and pnpm test, then open the pull request against dsh-pet. dsh-web itself consumes the published @linxin666/dsh-pet package and reads the pet content pinned by the submodule gitlink when building the market. Use when the user asks to create/add/develop/接入 a pet (宠物), build or calibrate a pet spritesheet, register a custom pet, author a status decoration or voice pack, or asks how pets are discovered and rendered.
whenToUse: 用户要新建/开发/接入一只宠物（桌面宠物、dsh-pet）、制作或校准宠物图集与 pet.json、制作语音包（voice.json）或状态装饰（decoration.json）、把宠物贡献进 dsh-pet 的资产目录，或询问宠物如何被发现与渲染。美术与图集生成参考 hatch-pet skill；皮肤走 dsh-web-skin-developer skill。
disable-model-invocation: true
---

# 宠物开发者（dsh-pet 多宠物注册表）

宠物的制作与接入都在 [dsh-pet](https://github.com/zhu1090093659/dsh-pet) 仓库进行，在 dsh-web 里它是子模块 `satellites/dsh-pet`；一只宠物是 `assets/<id>/` 下的一个目录加一份 manifest，新增宠物不需要改宿主或客户端代码。契约归 dsh-pet 所有：宠物清单见 [contracts/pet-manifest-v2.schema.json](https://github.com/zhu1090093659/dsh-pet/blob/main/contracts/pet-manifest-v2.schema.json)，权威实现 [src/manifest-v2.ts](https://github.com/zhu1090093659/dsh-pet/blob/main/src/manifest-v2.ts)——v2 显式声明 `renderer`（`sprite2d` / `live2d` / `frames2d`），`license` 必填；语音包契约见 [contracts/voice-pack-v1.schema.json](https://github.com/zhu1090093659/dsh-pet/blob/main/contracts/voice-pack-v1.schema.json)；状态装饰契约见 [contracts/status-decoration-v1.schema.json](https://github.com/zhu1090093659/dsh-pet/blob/main/contracts/status-decoration-v1.schema.json)（权威实现 `src/decoration.ts`，内置 `assets/decorations/` 加用户目录 `$DSH_HOME/pets/decorations/<id>/`）；第三方素材声明见 [THIRD_PARTY_NOTICES.md](https://github.com/zhu1090093659/dsh-pet/blob/main/THIRD_PARTY_NOTICES.md)。字段清单、图集几何、语音包与装饰的校验规则以该仓库的 [CONTRIBUTING.md](https://github.com/zhu1090093659/dsh-pet/blob/main/CONTRIBUTING.md) 和 [README.md](https://github.com/zhu1090093659/dsh-pet/blob/main/README.md) / [README.zh.md](https://github.com/zhu1090093659/dsh-pet/blob/main/README.zh.md) 为准，本技能不重复。

## 1. 工作命令（全部在 dsh-pet 仓库里执行）

```sh
git submodule update --init satellites/dsh-pet   # 在 dsh-web 克隆里取得工作树；也可以直接 clone dsh-pet
git -C satellites/dsh-pet checkout main          # 上一步停在 gitlink 固定的提交（detached），改动提交到 main
cd satellites/dsh-pet
pnpm install
node scripts/dsh-pet.cjs validate <dir>          # manifest + 声明资产 + Live2D 引用闭包 + voice.json；逐条打印拒绝原因
node scripts/dsh-pet.cjs install <dir> [--force] # 校验后复制进 $DSH_HOME/pets/<id>/；注册表在宿主启动时构建，重启 dsh web 生效
pnpm typecheck
pnpm test                                        # 含 manifest 形态校验；scripts/*.test.mjs 的脚本测试由 CI 另跑
pnpm build
```

`package.json` 提供 `build` / `test` / `typecheck` / `prepare` / `pet:cli`；宠物相关维护脚本是 `scripts/dsh-pet.cjs`（校验/安装 CLI）与 `scripts/dsh-pet-migrate-v2.mjs`（v1 manifest 迁 v2，默认 dry-run，`--write` 落盘并留 `.bak`，附测试）。dsh-web 的根 `package.json` 里没有任何名字含 pet 的脚本。

## 2. 投稿流程（PR 开在 dsh-pet）

- 归属：只有要成为内置默认的宠物才放进 `assets/<id>/`；其余宠物是市场内容（Workshop 一键装到 `$DSH_HOME/pets/<id>/`），不属于这个仓库。
- 分支与提交：`main` 受分支规则集保护，无写权限的贡献者对 `main` 开 PR，协作者与所有者直接 push；Conventional Commits（`feat(pet): ...`），无 emoji。
- PR 模板的宠物投稿清单：`pet.json` 为 v2 manifest（`petManifestVersion: 2`、小写 kebab `id`、`displayName`、`author`、`license`、`renderer` 与对应渲染器块）；`node scripts/dsh-pet.cjs validate assets/<id>` 通过；图集保持 8 列 × 9 行契约（行序固定、未用格全透明）或 live2d / frames2d 轨道覆盖同样状态；`pnpm test` 与 `pnpm typecheck` 通过；美术资产获再分发授权并注明来源。
- 测试与决策记录：行为改动带测试，纯 UI 改动至少一条挂载断言；非平凡改动在该仓库 `.agents/notes/` 补决策记录。
- 进商店：PR 合并进 dsh-pet 后，还要在 dsh-web 移动 `satellites/dsh-pet` gitlink 并用 pinned 内容重建提交 `market/dist`；卫星仓三步流程（提交、推远程、移 gitlink）见 dsh-web 的 [CONTRIBUTING.md](../../../CONTRIBUTING.md)。

## 3. dsh-web 这一侧

- dsh-web 以已发布 npm 包 `@linxin666/dsh-pet` 消费宠物插件；宠物内容的改动是向 dsh-pet 提 PR，不是向 dsh-web 提，`.github/workflows/reject-non-content-pr.yml` 会关闭投错仓库的 PR 并指向正确仓库。
- 市场构建读取的宠物内容，是子模块 gitlink 记录的那个提交；`market-inputs.lock.json` 把 pet 输入映射到 `satellites/dsh-pet` 的 `assets/` 目录。
- `pnpm market:fetch` 把 pinned 内容物化进 `.market-inputs/`：子模块工作树正好在 pinned 提交上就复制它，否则下载该提交的 tarball，所以从未初始化子模块的克隆行为一致；`--force` 强制重取。
- `pnpm market:fetch --local` 从已初始化的子模块工作树物化其当前内容，用来把你自己的改动送进市场构建；不在 pinned 提交上的检出在不加 `--local` 时会被忽略（运行时输出会说明）。缓存按子模块 HEAD 提交记账，未提交的改动要加 `--force` 才会被重新复制；这样构建出的 `market/dist` 来自未 pin 的内容，不得提交。
- 开发循环：编辑 `satellites/dsh-pet/assets/<id>/`，`node scripts/dsh-pet.cjs validate` 通过后 `pnpm market:fetch --local --force` 与 `pnpm market:build`，从 `market/dist` 看市场产物。
- `pnpm market:check` 校验已提交的 `market/dist` 与 pinned 输入一致。

## 4. 验收清单

- [ ] 宠物目录在 dsh-pet 的 `assets/<id>/`，manifest 满足 `contracts/pet-manifest-v2.schema.json` 与 `src/manifest-v2.ts`（v2 必填 `license`，投稿还需 `author`）
- [ ] `node scripts/dsh-pet.cjs validate assets/<id>` 通过
- [ ] 在 dsh-pet 里 `pnpm typecheck` 与 `pnpm test` 通过
- [ ] 美术资产获再分发授权并注明来源（第三方角色与素材见 THIRD_PARTY_NOTICES.md）
- [ ] PR 开在 dsh-pet（不是 dsh-web），按该仓库 PR 模板逐项勾选并附验证记录
- [ ] 进市场的改动：dsh-pet 合并后已在 dsh-web 移动 gitlink，`market/dist` 已用 pinned 内容重建并提交，`pnpm market:check` 通过；用 `--local` 构建的产物没有提交

## 5. 常见坑

- **在 dsh-web 里找宠物 CLI**：dsh-web 的根 `package.json` 里没有任何名字含 pet 的脚本；`scripts/dsh-pet.cjs` 与测试都在 dsh-pet。
- **`node scripts/dsh-pet` 少写 `.cjs` 后缀会直接失败**：文件名是 `scripts/dsh-pet.cjs`（或用 `pnpm pet:cli`）。
- **把宠物改动留在 dsh-web 的 `satellites/dsh-pet` 工作树里**：那只是本地预览，投稿仍然要开在 dsh-pet 仓库。
- **只提交卫星仓不推远程、不移 gitlink**：三步缺一不可，漏掉 push 会让全新克隆与 CI 的 `pnpm market:fetch` 404（见 dsh-web CONTRIBUTING.md）。
- **提交 `--local` 构建出的 `market/dist`**：它来自未 pin 的内容，`pnpm market:check` 会失败。
- **子模块不在 pinned 提交上**：不加 `--local` 的 `pnpm market:fetch` 会忽略你的工作树，输出里会说明这一点。
