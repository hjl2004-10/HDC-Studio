# Engineering guidance

- Keep the Windows desktop layout compact, with one application toolbar and distinct per-device state.
- Investigate the underlying data flow before changing behavior. Keep HDC commands bound to their target device; preserve filenames, process identity checks and meaningful errors.
- Display real device metrics. Keep unavailable values distinct from zero and retain timestamps on cached data. Run recursive storage analysis only on request.
- Store user settings in the local JSON configuration. Do not commit settings, device IDs, logs, credentials, SDK binaries or build artifacts.
- Retain context isolation and the restricted preload API. Do not expose unrestricted Node.js or shell execution to the renderer.
- Keep work focused. Use a running development build for human feedback; do not introduce or run automated test suites unless requested. Do not manipulate user device files or terminate their processes to verify a change.
- Build or publish release artifacts only when requested. Preserve third-party licenses and document the provenance of any supplied SDK tools.
