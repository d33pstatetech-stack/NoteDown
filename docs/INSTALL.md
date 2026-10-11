# Installing NoteDown on Windows and Linux

NoteDown is a local-first Markdown notes app. Notes are stored on your own
machine, in a SQLite database, and the app works completely offline. Signing in
to an account is optional and only adds sync between devices.

---

## Quick start

### Windows

1. Install the prerequisites:

   | Tool | Version | Install |
   |---|---|---|
   | [Node.js](https://nodejs.org) | 20.19 or newer | `winget install OpenJS.NodeJS.LTS` |
   | [Rust](https://rustup.rs) | stable | `winget install Rustlang.Rustup` |
   | [pnpm](https://pnpm.io/installation) | 9.x | `npm install -g pnpm` |
   | [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) | 2022 or newer, **Desktop development with C++** | same page, pick the C++ workload |

2. Open a terminal and build:

   ```powershell
   git clone https://github.com/d33pstatetech-stack/NoteDown.git
   cd NoteDown
   corepack enable
   pnpm install
   pnpm dev:desktop
   ```

The app window opens. You can write notes immediately — no account needed.

> **Building in a path with spaces?** Windows builds fail with
> `cc1.exe: fatal error` / `windres: preprocessing failed` if the repository sits
> somewhere like `C:\Users\me\My Projects\NoteDown`. Either clone to a path
> without spaces, or set the target directory as shown in
> [Troubleshooting](#troubleshooting).

### Linux

1. Install the prerequisites:

   ```bash
   # Debian / Ubuntu
   sudo apt update
   sudo apt install -y curl build-essential file wget libwebkit2gtk-4.1-dev \
     libappindicator3-dev librsvg2-dev patchelf libssl-dev libxdo-dev \
     libayatana-appindicator3-dev

   # Fedora
   sudo dnf install -y curl wget file webkit2gtk4.1-devel openssl-devel \
     libappindicator-gtk3-devel librsvg2-devel patchelf libxdo-devel \
     libayatana-appindicator-gtk3-devel

   # Arch
   sudo pacman -S --needed curl wget file webkit2gtk-4.1 base-devel \
     openssl appmenu-gtk-module libappindicator-gtk3 librsvg patchelf xdo-lib
   ```

   Then install the language toolchains:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"

   # Node.js 20.19+ (nvm)
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   nvm install 20 && nvm use 20

   npm install -g pnpm@9
   ```

2. Build and run:

   ```bash
   git clone https://github.com/d33pstatetech-stack/NoteDown.git
   cd NoteDown
   corepack enable
   pnpm install
   pnpm dev:desktop
   ```

The app window opens. You can write notes immediately — no account needed.

---

## Making an installer

Use this when you want a standalone app instead of running from source.

```bash
pnpm dev:desktop          # run from source (hot reload)
pnpm --filter @localnotes/desktop run build   # produce an installer
```

The installer lands in the Rust target directory, which is under the
desktop app's `src-tauri` folder by default:

| OS | Path |
|---|---|
| Windows | `apps\desktop\src-tauri\target\release\bundle\nsis\NoteDown_<version>_x64-setup.exe` |
| Linux | `apps/desktop/src-tauri/target/release/bundle/nsis/NoteDown_<version>_x64-setup.exe` |

Both paths are relative to the repository root. If you set `CARGO_TARGET_DIR`
(see [Troubleshooting](#troubleshooting)), the output moves to that directory
instead — for example `C:\nd-target\release\bundle\nsis\`.

### Windows notes

- The installer is an NSIS package. Run it and follow the prompts.
- Microsoft Edge **WebView2** must be installed. It ships with Windows 11 and
  current Windows 10, and with Edge itself. If the app opens to a blank window,
  install it from <https://developer.microsoft.com/microsoft-edge/webview2/>.
- Windows may warn about an unrecognised publisher. This is expected: the app is
  not code-signed.

### Linux notes

- `webkit2gtk` provides the web view. It is listed in the packages above and is
  the dependency most likely to be missing if the build fails.
- If you only want to run the app, the `.deb`/`.AppImage` targets can be added to
  `bundle.targets` in `apps/desktop/src-tauri/tauri.conf.json` (currently
  `["nsis"]`).
- On GNOME or KDE, launchers appear in your application menu after install.

---

## Where your notes are stored

Notes are a plain SQLite database in your user data directory. Copy that
directory to back everything up.

| OS | Location |
|---|---|
| Windows | `%APPDATA%\com.notedown.app\` |
| Linux | `~/.local/share/com.notedown.app/` (or `$XDG_DATA_HOME/com.notedown.app/`) |

Inside it:

- `notes.sqlite3` — notebooks, folders, notes, attachments, sync queue
- `notes.sqlite3-wal`, `notes.sqlite3-shm` — write-ahead log. Copy them
  together with the database.
- `attachments/` — image files

**Back up** by copying the whole folder while the app is closed. For a live
backup use `sqlite3 notes.sqlite3 "VACUUM INTO 'backup.sqlite3'"`.

The in-app **Export** button produces a ZIP of plain Markdown files. That format
needs no SQLite and is the most portable backup.

More detail: [`docs/DATA-LOCATIONS.md`](DATA-LOCATIONS.md).

---

## Optional: connecting an account

Sign in from the app to sync notes across devices. Skipping this is fine — the
app is fully functional offline and nothing is stored on a server.

The built app points at the hosted sync service:

```
https://notedown-api.d33pstatetech.workers.dev
```

To build against a different backend, set the URL before building:

```bash
# Linux / macOS
VITE_API_URL=https://your-worker.example.workers.dev pnpm --filter @localnotes/desktop run build

# Windows PowerShell
$env:VITE_API_URL="https://your-worker.example.workers.dev"
pnpm --filter @localnotes/desktop run build
```

If `VITE_API_URL` is not set, the app builds and runs in local-only mode with
sync disabled. That is a supported configuration, not an error.

When you point the app at a different backend, add that origin to the
`connect-src` entry in `apps/desktop/src-tauri/tauri.conf.json`. The Content
Security Policy blocks any origin that is not listed, so a mismatch shows up as
the app silently failing to sync.

---

## Troubleshooting

**`pnpm: command not found`** — install it with `npm install -g pnpm@9`, or run
`corepack enable` in the repository first.

**Windows build fails in `windres` or `cc1.exe` with a path error** — MinGW and
MSVC both struggle with spaces in paths. This happens when the repository lives
somewhere like `C:\Users\me\My Projects\NoteDown`. Move it to a path without
spaces, or point the build somewhere clean:

```powershell
$env:CARGO_TARGET_DIR = "C:\nd-target"
pnpm --filter @localnotes/desktop run build
```

**Linux: `pkg-config` could not find `webkit2gtk-4.1`** — install the
`webkit2gtk` development package for your distribution (see the list above).
Tauri 2 needs the 4.1 series, not the older `webkit2gtk2gtk-4.0`.

**Linux: `error while loading shared libraries`** — the build succeeded but the
app will not start. You built against a newer webkit than the system provides at
runtime. Install `webkit2gtk-4.1` as a normal (non-dev) package as well.

**The app opens to a blank white window** — almost always a missing WebView2
runtime on Windows. See the WebView2 note above.

**Build is slow the first time** — expected. Rust compiles the standard library
and the Tauri stack from source on a cold build, which takes several minutes.
Later builds are much faster.

**Sign-in fails but the app otherwise works** — this is the expected behaviour
when the network is unavailable. Local notes are unaffected and stay on the
machine; sync resumes on its own once the connection is back.

---

## Requirements summary

| | Windows | Linux |
|---|---|---|
| Node.js | 20.19+ | 20.19+ |
| pnpm | 9.x | 9.x |
| Rust | stable, MSVC target | stable, default target |
| C++ toolchain | Visual Studio Build Tools 2022 (C++ workload) | `build-essential` + `webkit2gtk-4.1` |
| Runtime | Edge WebView2 (preinstalled on Win 11) | `webkit2gtk-4.1` |

Verified on Windows 11 with Node v25.9.0, pnpm 9.15.9, and Rust 1.99.0.