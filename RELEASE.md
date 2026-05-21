# Release & Distribution

## Build a local bundle

```bash
npm install
npm run tauri build
```

Outputs (under `src-tauri/target/release/bundle/`):

- `macos/Vellum.app` — the application bundle
- `dmg/Vellum_<version>_aarch64.dmg` — drag-to-Applications installer

The release profile is size-optimized (`opt-level = "s"`, LTO, stripped) — see
`src-tauri/Cargo.toml`. The resulting `.app` is ~5.4 MB (vs ~100 MB+ for an
Electron equivalent).

> **DMG note:** `bundle_dmg.sh` styles the installer window via AppleScript/
> Finder, so the `.dmg` step requires a real GUI login session. In a headless/
> CI/sandboxed shell the `.app` builds fine but the `.dmg` step fails. To build
> only the app there, set `"targets": "app"` (or run on a GUI session / a CI
> runner with a logged-in desktop).

## Versioning

Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`
(`version`) before building a release.

## Code signing & notarization (required for distribution) — TODO

The build above is **unsigned**. macOS Gatekeeper will warn users (and on
Apple Silicon may refuse to open) an unsigned, un-notarized app downloaded from
the internet. To distribute outside your own machine you need an Apple Developer
account and must sign + notarize. This is intentionally deferred for v1.

When ready, Tauri reads these environment variables during `npm run tauri build`:

| Variable | Purpose |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | "Developer ID Application: …" certificate name |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | base64 .p12 + password (CI) |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | notarization credentials (app-specific password) |

Steps:
1. Enroll in the Apple Developer Program; create a **Developer ID Application**
   certificate.
2. Set the env vars above; Tauri signs the `.app` and submits to Apple's
   notary service automatically, then staples the ticket.
3. Verify: `spctl -a -vvv "Vellum.app"` should report `accepted / Notarized`.

References: Tauri macOS code-signing docs (`v2.tauri.app` → Distribute → macOS).

## Smoke test before shipping

```bash
SMOKE_RUN_SECONDS=8 bash scripts/smoke.sh   # launches the dev app, checks for panics
npm test                                     # unit tests
```

Then run through `docs/QA-CHECKLIST.md` manually (native menus, dirty guard,
Open Recent, theme, Find — these can't be automated on macOS).
