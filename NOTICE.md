# Third-party components

HDC Studio is an independent desktop client. It is not an official OpenHarmony or Huawei product. Its MIT license covers original code and documentation; third-party components retain their own licenses.

- HDC upstream: [openharmony/developtools_hdc](https://github.com/openharmony/developtools_hdc), Apache-2.0. The reference LICENSE is archived in `third_party/hdc/`. This upstream snapshot has no root NOTICE file.
- libusb: [libusb/libusb](https://github.com/libusb/libusb), LGPL 2.1 or later in original source headers. The [OpenHarmony integration](https://github.com/openharmony/third_party_libusb) metadata labels its snapshot LGPL-2.1-only. Reference COPYING and README.OpenSource are archived in `third_party/libusb/`; these do not identify the locally supplied DLL's version.
- Electron: MIT; Chromium and other notices are included in the packaged runtime's LICENSE and LICENSES.chromium.html.
- xterm.js 6.0.0 and addon-fit 0.11.0: MIT; copies of the installed package licenses are in `third_party/xterm/`.
- node-pty 1.1.0: MIT; its package license is in `third_party/node-pty/`. Preserve the additional notices included with native terminal components.

The public Git source excludes SDK EXE and DLL files. Source users supply a compatible HDC SDK and preserve its companion files. Device communication is performed by the selected HDC executable.

The local 0.1.0 build can include HDC 3.2.0c and `libusb_shared.dll` from an existing SDK installation. Their exact source revisions, libusb version, build modifications and complete redistribution materials have not been established. The archived upstream references do not establish that correspondence, and this local bundle is not a ready-to-publish third-party binary distribution.

For a public binary release, use a traceable SDK distribution or reproducible build and supply the applicable license, attribution and corresponding source materials. Alternatively, distribute the application without SDK binaries and let users select an existing SDK installation. Reference provenance is recorded in [third_party/README.md](third_party/README.md).
