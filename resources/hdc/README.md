# 提供本地 HDC 工具

公开 Git 源码不包含 HDC 的 EXE 或 DLL。请从与你的设备匹配的 OpenHarmony SDK 获取 Windows 工具，参考 [HDC 官方获取与构建说明](https://github.com/openharmony/developtools_hdc/blob/master/README_zh.md)。

可选择以下一种用法：

- 启动应用，在设置中选择 SDK 安装目录内的 `hdc.exe`，保留旁边的配套 DLL。
- 将 `hdc.exe` 及所需 DLL 一起复制到本目录，供开发运行和本机构建使用。
- 将 `HDC_PATH` 环境变量设为 `hdc.exe` 的完整路径，或将工具所在目录加入 `PATH`。

手动设置路径优先于自动查找。自动查找优先采用本目录内的工具，然后检查环境变量。`DEVECO_SDK_HOME` 下的常见 `toolchains` 目录也会被检查。

构建脚本会将本目录放入应用的 `resources/hdc/`。不放入二进制时，应用仍能启动，但连接设备前需选择外部 SDK 工具。HDC 与 DLL 需配套；仅复制 EXE 可能导致启动失败。

本目录的 `*.exe`、`*.dll`、`*.pdb` 默认不被 Git 跟踪。公开再分发 SDK 二进制前，应确定具体版本、来源及适用的许可证、声明和源码材料。仓库中的[第三方参考文件](../../third_party/README.md) 不代替某个 SDK 构建的对应材料，详见 [NOTICE](../../NOTICE.md)。
