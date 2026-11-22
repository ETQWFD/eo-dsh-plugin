# EO助手 DSH 插件

把手机变成 DeepSeek Harness 的远程眼睛和输入设备。插件在 DSH 设置页生成二维码，手机扫码即完成设备注册与端到端加密绑定；**不需要填写 relay 地址，也不需要在电脑上另开服务**。

- 每台手机 = 一个 DSH Session（`eo-<convId>`），消息、图片、文件、语音、PPT 都进入同一个会话。
- 手机图片会先压缩，再由插件调用 DSH `attachments.admitPromptContent` 转成真正的 `image` 内容块，`deepseek-flash` 等声明图片输入的模型可以直接看图。
- 默认在 `$DSH_HOME/eo/relay.sqlite` 启动内置 relay，自动选局域网地址；也可配置外部 relay。
- 所有消息和附件都是 AES-256-GCM 密文，relay 只转发密文，不持有私钥。

## 安装

要求：DeepSeek Harness `>= 0.2.2-rc.2 < 0.4.0`，Node `>= 24.9.0`。

```bash
# web / 桌面版 / lite / macOS 的 profile 名可能不同，换成你实际启动的那个
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin

# 如果上面因为网络或 pnpm 版本失败，用等价写法
dsh plugin --profile web add git+https://github.com/ETQWFD/eo-dsh-plugin.git
```

**不要写成大写的 `GITHUB:`**。pnpm 11 会把它当成 scp 风格地址，解析成 `https://github.com/eo-dsh-plugin/.git/`，报 `Repository not found`。

重启 DSH，打开：

```
设置 → EO助手连接 → 生成二维码
```

用手机 EO助手右上角“扫一扫”扫描。桌面会显示 6 位确认码，手机输入后即绑定。整个过程不出现 relay 输入框。

### 桌面版 / lite / macOS

插件本身是纯 ESM + 已构建的 `lib/client.js`，没有原生二进制，因此 Windows 不需要 Authenticode、macOS 不需要 notarize。安装仍是同一条 `dsh plugin` 命令，只需把 `--profile web` 换成应用实际使用的 profile：

```bash
dsh plugin --profile desktop add github:ETQWFD/eo-dsh-plugin
# 或 lite / 自定义 profile 名
dsh plugin --profile <profile> add github:ETQWFD/eo-dsh-plugin
```

安装后在对应 profile 的 DSH Web 设置页即可看到“EO助手连接”。如果桌面版从旧版本升级，先重启应用，让插件重新加载。

### 手机

- Android：安装 Release 里的 `eo-assistant-0.3.0.apk`。首次打开就是内置扫码页，扫桌面二维码后自动进入聊天，不再手填地址。
- iPhone / 其他浏览器：打开桌面设置页诊断信息里的 `<relayUrl>/app/`。浏览器 PWA 需要 HTTPS 或 localhost；局域网 HTTP 仅在 Android 内置安全源里可用。

## 零配置是怎么做到的

1. 插件启动时若没有外部 `relayUrl`，就在 `$DSH_HOME/eo/relay.sqlite` 启动内置 relay，默认端口 `8787`；端口占用时自动换随机端口。
2. 插件选取第一个非 link-local 的局域网 IPv4，二维码里的 `r` 参数就是 `http://<局域网IP>:<端口>`。
3. 手机扫码后只用这个地址完成 claim / confirm，设备自动注册，双方各自生成并保存身份密钥。
4. 下次启动，手机从本地安全存储恢复 relay 和会话，不再需要扫码。

如果电脑有多张网卡（VPN、虚拟网卡），自动选的地址手机可能访问不到。此时设置环境变量后重启 DSH：

```bash
EO_RELAY_HOST=192.168.1.10 dsh web
```

Windows PowerShell：

```powershell
$env:EO_RELAY_HOST="192.168.1.10"; dsh web
```

### 使用外部 relay

已有公网 relay 时，在 profile 的 `cordis.patch.yml` 写入：

```yaml
- id: eo-assistant
  config:
    relayUrl: https://eo.example.com
    assistantName: EO助手
    # provider / model 可选，不填使用 DSH 当前默认模型
    # workspaceDir 可选，默认当前工作目录
    # maxFileMB 可选，默认 50
```

配置了 `relayUrl` 就不会启动内置 relay。公网必须 HTTPS；内置 relay 的局域网 HTTP 只适用于 Android 内置 PWA 或本机 localhost。

## 能力

- 扫码绑定：桌面生成二维码 → 手机 claim → 桌面显示 6 位确认码 → 手机输入确认。
- 双向 E2EE 文本；每台手机一个 DSH Session `eo-<convId>`。
- 图片视觉：手机相册/拍照 → 最长边 1600px、JPEG、≤4MB → 加密 blob → 桌面解密校验 → DSH 图片附件 → 模型可见。
- 文件/语音/PPT：加密 blob 上传，桌面解密校验 SHA-256 后落到 `eo/<convId>/attachments/`。
- 手机端图片卡片直接显示本地预览；点“查看”解密全屏查看。
- 名称/头像：桌面设置页修改后，relay 推 `profile`，手机自动刷新。
- 在线状态：绑定确认后双方立即显示在线；断线重连后自动恢复。
- 离线：relay 保存密文 backlog，重连补收；重复 msgId 去重。

## 目录

```
<workspace>/eo/index.json
<workspace>/eo/<convId>/meta.json
<workspace>/eo/<convId>/messages.jsonl
<workspace>/eo/<convId>/attachments/
```

插件数据目录是 `$DSH_HOME/eo/`，内置 relay 数据库为 `relay.sqlite`，blob 在 `blobs/`。

## 开发与测试

```bash
npm install
npm run build:client   # esbuild -> lib/client.js，DSH 要求单文件 __ModuleLoader__ 包装
node --test test/*.test.js
```

`lib/client.js` 已提交，安装时不需要构建；修改 `src/client/` 后必须重新构建并提交。

## 安全边界

- relay 只保存密文信封和密文附件；没有明文、私钥、模型 API Key、GitHub token。
- 桌面私钥在 `$DSH_HOME/eo/identity.json`（0600）；手机在 Android Keystore；浏览器在 localStorage。
- 二维码有效期 120 秒，确认码是防中间人的第二通道。
- 内置 relay 监听 `0.0.0.0`，同一局域网内可见。不要在不可信 Wi-Fi 上使用；需要跨公网时配置 HTTPS 外部 relay。
- GitHub 私密仓库只能存代码，不能充当 WebSocket/注册/聊天服务器；不要把 GitHub token 写进 APK/PWA。
