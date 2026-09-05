# HDC Studio

面向 Windows 的 OpenHarmony 设备管理桌面应用，将 HDC 设备连接、交互终端、文件传输与资源监控放在一个窗口中。

当前版本：**0.1.0**。应用原创代码使用 [MIT 许可证](LICENSE)。本项目是独立工具，非 OpenHarmony 或华为官方产品。

## 功能

- 自动发现 USB 设备，添加 TCP 连接；按唯一设备 ID 保存自定义名称。
- 多标签交互终端，支持命令输入、历史、复制粘贴、清屏和导出。
- 浏览远程目录，上传与下载文件或文件夹，新建目录、重命名、删除及文本预览。
- CPU、内存、交换空间、进程、网卡速率与磁盘容量监控；显示设备实际支持的 NPU 指标。
- 进程详情、打开程序目录、发送 TERM/KILL，以及按需查看目录占用。
- 每台设备分别保留终端、目录、选择项、资源快照和滚动位置；切换时先显示缓存，再后台更新。
- 界面与终端字号独立设置，配置以 JSON 保存在本机。

NPU 主面板只显示可用指标，不支持或失败的具体原因在详情中查看。设备管理操作使用真实 HDC 请求，未连接时不生成示例数据。

## 运行环境

- Windows x64；已在 Windows 11 上进行实际设备体验。
- 开发与构建需要 Node.js **22.12 或更新版本**及 npm。
- 设备须已启用 HDC 调试，电脑具备对应 USB 驱动，或能够访问设备的网络调试端口。
- 资源监控面向具有 Linux `/proc`、`df` 等接口的 OpenHarmony 设备；NPU 需要设备侧提供兼容的 `npu-smi`。不同板卡、系统版本和权限可能提供不同指标。

## 从源码启动

```powershell
npm ci
npm start
```

公开源码不包含 SDK 的 EXE/DLL。请启动应用后，在设置中选择配套 SDK 内的 `hdc.exe`，保留其旁边的 DLL；也可以将工具复制到 `resources/hdc/`。详细用法见 [HDC 工具配置](resources/hdc/README.md)。

首次运行可能需要下载 Electron。默认依赖版本由 `package-lock.json` 锁定。

## 构建 Windows 版本

```powershell
# 生成可直接运行的应用目录
npm run pack

# 生成单文件免安装 EXE
npm run dist
```

输出位置：

- `dist/win-unpacked/HDC Studio.exe`：目录版入口，需保留旁边的运行文件。
- `dist/HDC-Studio-0.1.0-Windows-x64.exe`：免安装版入口，启动时会先解压运行组件。

构建会携带本地 `resources/hdc/` 中的工具；没有工具时也能构建，运行后需选择外部 SDK。构建缓存位于 `.cache/electron-builder/`，脚本先解析真实目录，兼容 Windows 的目录重定向。构建脚本不会自动发布到远程平台。

## 使用

1. 连接 USB 设备，或使用“网络连接”填写设备实际调试地址。设备列表会自动更新。
2. 点击设备卡片上的铅笔按钮命名，也可在卡片获得焦点后按 F2。名称绑定唯一 ID，留空恢复默认名称。
3. 在终端直接输入命令，在文件区双击目录浏览；传输任务可在底部查看和取消。
4. 点击资源栏中的“管理”“详情”或磁盘条目查看明细。“目录占用”只在点击时扫描。

设置中的 `127.0.0.1:8710` 是**电脑上的 HDC 服务地址**；设备网络连接使用设备自己的地址与调试端口。HDC 不使用 SSH 协议。

配置位置通常为 `%APPDATA%/HDC Studio/settings.json`，包含 HDC 路径、默认目录、字体和设备别名。配置、传输日志及本地 SDK 二进制均不纳入 Git。

## 指标与操作说明

- 系统及进程约每 3 秒采样，NPU 与存储约每 10 秒采样，仅当前选中设备持续轮询。
- CPU 与网速按同一设备前后两次有效计数计算。切换间隔计入平均值；设备重启后重新建立基线。进程 CPU 的 100% 表示占用一个核心。
- 内存使用为 `MemTotal - MemAvailable`。未知指标不显示成零；上次采样时间和读取失败状态独立显示。
- USB 调试传输不计入网卡流量。目录占用使用磁盘实际分配空间，可能与文件逻辑大小不同。
- 文件夹传输保留目录结构，同名合并或覆盖会确认。符号链接不跟随传输；取消任务可能保留已经完成的文件。
- 删除文件、结束进程和重启设备会要求确认；结束进程前会重新核对 PID 与启动身份。

## 源码结构

```text
src/main.js          Electron 主进程、设置及受限 IPC
src/preload.js       界面可调用的设备接口
src/renderer/        界面、文件浏览与 xterm 终端
src/lib/hdc.js       HDC 调用、设备与文件读取
src/lib/terminal.js  Windows ConPTY 交互会话
src/lib/transfers.js 文件传输队列
src/lib/monitor.js   分设备采样与计数缓存
src/lib/management.js 进程及存储管理
scripts/build-win.cjs Windows 构建入口
```

修改后通过 `npm start` 进行本地体验。本仓库未配置自动化测试套件。版本记录见 [CHANGELOG](CHANGELOG.md)。

## 许可证与第三方组件

原创代码使用 [MIT](LICENSE)。HDC、libusb、Electron、xterm.js 和 node-pty 各自保留原许可证，详见 [NOTICE](NOTICE.md) 与 [第三方许可来源](third_party/README.md)。

本地 SDK 二进制默认不进入公开 Git 仓库。若公开分发包含 SDK 的二进制版本，需要根据所用 SDK 的具体版本提供对应许可证、声明及适用的源码材料；此仓库归档的参考文件不代表任意 SDK 构建的完整分发材料。
