# Third-party license references

These files preserve upstream license text and provenance. The HDC/libusb snapshots are references, not identified source revisions for separately supplied SDK binaries.

- `hdc/LICENSE`: unchanged [OpenHarmony HDC LICENSE](https://github.com/openharmony/developtools_hdc/blob/d83f05cfc7b6b0b93555671a92dcb1296333834b/LICENSE), commit `d83f05cfc7b6b0b93555671a92dcb1296333834b`, Apache-2.0. That snapshot has no root NOTICE file.
- `libusb/COPYING` and `libusb/README.OpenSource`: unchanged files from [OpenHarmony third_party_libusb](https://github.com/openharmony/third_party_libusb/tree/6e543579590eb9afe94b4e893d6f9afbb77a6808), commit `6e543579590eb9afe94b4e893d6f9afbb77a6808`. Its metadata identifies version 1.0.28 and LGPL-2.1-only; this does not identify the version of a local DLL.
- Original libusb source headers allow LGPL 2.1 or later; see [libusb/core.c](https://github.com/libusb/libusb/blob/a45bb163a603ac5ae3499806b151509848b0065c/libusb/core.c). The reference COPYING text is LGPL 2.1. Consult the actual SDK distribution for its applicable notices and corresponding source.
- `xterm/LICENSE-xterm` and `xterm/LICENSE-addon-fit`: copied from the installed `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 npm packages.
- `node-pty/LICENSE`: copied from the installed `node-pty` 1.1.0 package. Preserve additional notices supplied inside that package.
- Electron retains its own `LICENSE` and `LICENSES.chromium.html` in the runtime distribution. These must remain in the application build.

Include this directory, the project's [LICENSE](../LICENSE) and [NOTICE](../NOTICE.md), and all notices supplied with shipped dependencies in a binary build. HDC Studio's MIT license does not replace dependency licenses.
