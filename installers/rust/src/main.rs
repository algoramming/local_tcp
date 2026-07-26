// Local TCP — Cross-platform Native Messaging Host installer (Rust)
// =============================================================================
// Installs the Node.js host (index.js) and registers it with Chromium-family
// browsers so the Local TCP extension can reach it.
//
// WHY a Node host (not a compiled binary): on macOS 15/26, Local Network
// Privacy keys LAN access to the executable's code identity. Routing through
// the system `node` (which macOS recognizes) is allowed to reach 192.168.x.x;
// a bare custom binary is silently denied. So Chrome must end up running
// `node index.js`, which is exactly what this installer wires up:
//   * macOS / Linux : manifest "path" -> index.js, whose shebang we rewrite to
//                     the absolute node path (so it never depends on $PATH).
//   * Windows       : manifest "path" -> run_bridge.bat, which calls node; the
//                     host is registered via HKCU registry keys.
//
// Usage:
//   localtcp-installer            # install (default)
//   localtcp-installer install
//   localtcp-installer uninstall
//   localtcp-installer -y         # never wait for a keypress (scripted use)
//
// The host's index.js and manifest template are embedded at compile time, so
// the resulting installer is a single self-contained binary.
//
// WINDOWS DIAGNOSABILITY: this is a console program, and Windows tears down the
// console the moment the last attached process exits. Double-clicked from
// Explorer it therefore flashes and vanishes — success and failure look
// identical, and any error message is destroyed with the window. Two mechanisms
// exist to stop that: every printed line is mirrored into a log file, and we
// block on a keypress before exiting when we own the console. See
// `hold_window` and `flush_transcript`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const HOST_NAME: &str = "com.algoramming.localtcp";
const VERSION: &str = env!("CARGO_PKG_VERSION");

// Embedded assets (resolved relative to this crate's Cargo.toml).
const INDEX_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/index.js"));
const MANIFEST_TMPL: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/com.algoramming.localtcp.json"));

// --- Transcript --------------------------------------------------------------
// Everything we print is also buffered here and flushed to a log file on exit,
// so a run whose console disappeared can still be read afterwards.
static TRANSCRIPT: Mutex<String> = Mutex::new(String::new());

fn record(line: &str) {
    if let Ok(mut t) = TRANSCRIPT.lock() {
        t.push_str(line);
        t.push('\n');
    }
}

/// Print to stdout and mirror into the transcript.
macro_rules! say {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        println!("{s}");
        record(&s);
    }};
}

/// Print to stderr and mirror into the transcript.
macro_rules! warn {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        eprintln!("{s}");
        record(&s);
    }};
}

fn log_path() -> PathBuf {
    env::temp_dir().join("localtcp-install.log")
}

fn flush_transcript() -> Option<PathBuf> {
    let p = log_path();
    let body = TRANSCRIPT.lock().ok()?.clone();
    fs::write(&p, body).ok()?;
    Some(p)
}

fn main() {
    // The hook runs even under panic="abort", so an unexpected crash still
    // leaves a transcript behind and a window the user can actually read.
    std::panic::set_hook(Box::new(|info| {
        let s = format!("\n[FATAL] {info}");
        eprintln!("{s}");
        record(&s);
        let _ = flush_transcript();
        hold_window();
    }));

    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help" || a == "help") {
        print_help();
        return;
    }
    // `-y` / `--no-pause` is for the macOS .pkg and Linux .run wrappers, and for
    // anyone driving this from a script, where blocking on stdin would hang.
    let scripted = args.iter().any(|a| a == "-y" || a == "--no-pause");

    // Mode resolution: an explicit arg wins; otherwise infer from the executable's
    // own filename. This lets us ship the SAME compiled binary under two names —
    // `...installer.exe` installs, `...uninstaller.exe` uninstalls — so the bare
    // Windows .exe (launched with no args by a double-click) does the right thing.
    let action = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .cloned()
        .unwrap_or_else(default_action_from_exe_name);

    let result = match action.as_str() {
        "install" => install(),
        "uninstall" => uninstall(),
        other => Err(format!("unknown command '{other}'. Use: install | uninstall")),
    };

    let failed = result.is_err();
    if let Err(e) = result {
        warn!("\n[ERROR] {e}");
        if e.contains("Node") {
            warn!("Install Node.js manually from https://nodejs.org/ and re-run this installer.");
        }
    }
    if let Some(p) = flush_transcript() {
        say!("\nA full log of this run was saved to:\n  {}", p.display());
    }

    if !scripted {
        hold_window();
    }
    if failed {
        std::process::exit(1);
    }
}

fn default_action_from_exe_name() -> String {
    let name = env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if name.contains("uninstall") {
        "uninstall".to_string()
    } else {
        "install".to_string()
    }
}

fn print_help() {
    println!("Local TCP host installer v{VERSION}\n");
    println!("  localtcp-installer            install (default)");
    println!("  localtcp-installer install    install and register the host");
    println!("  localtcp-installer uninstall  remove the host and all registrations");
    println!("  localtcp-installer -y         don't wait for a keypress before exiting");
}

// --- Keeping the window open (Windows) ---------------------------------------
// Windows destroys a console once the last process attached to it exits, so an
// .exe launched from Explorer flashes and disappears — which is precisely what
// "it opens a terminal and immediately closes, no error" looks like.
// GetConsoleProcessList tells us how many processes share our console: 1 means
// we're the only one and the window dies with us (Explorer launch), while 2+
// means a shell is hosting us and its output survives. We only block in the
// first case, so running from cmd/PowerShell/CI stays non-interactive.
fn hold_window() {
    #[cfg(windows)]
    {
        use std::io::{stdin, stdout, Write};

        if !owns_console() {
            return;
        }
        print!("\nPress Enter to close this window . . . ");
        let _ = stdout().flush();
        let mut sink = String::new();
        let _ = stdin().read_line(&mut sink);
    }
}

#[cfg(windows)]
fn owns_console() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleProcessList(lpdwProcessList: *mut u32, dwProcessCount: u32) -> u32;
    }
    let mut pids = [0u32; 8];
    // Returns the total number of processes attached to our console. 0 means we
    // have no console at all (nothing to keep open).
    let n = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) };
    n == 1
}

// --- Install ---
fn install() -> Result<(), String> {
    banner(&format!("Local TCP Bridge — Installer v{VERSION}"));

    let node = match find_node() {
        Some(n) => n,
        None => {
            warn!("[WARN] Node.js was not found in PATH or in any known install location.");
            install_node_automatically().ok_or_else(|| {
                format!("Node.js is required but could not be installed automatically.\n  {}", node_install_hint())
            })?
        }
    };
    say!("[OK] Using Node at: {node}");

    let dir = resolved_install_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    say!("[INFO] Install dir: {}", dir.display());

    // 1. Write index.js. On Unix, rewrite the shebang to the absolute node path
    //    so execution never depends on the (often minimal) inherited PATH.
    let index_path = dir.join("index.js");
    let index_contents = if cfg!(windows) {
        INDEX_JS.to_string()
    } else {
        patch_shebang(INDEX_JS, &node)
    };
    write_file(&index_path, &index_contents)?;
    make_executable(&index_path);
    say!("[INFO] Wrote {}", index_path.display());

    // 2. Determine the executable the manifest "path" should point at.
    let host_path: PathBuf = if cfg!(windows) {
        // Windows native messaging needs a launcher executable, not a .js.
        let bat = dir.join("run_bridge.bat");
        let contents = format!("@echo off\r\n\"{}\" \"%~dp0index.js\" %*\r\n", node);
        write_file(&bat, &contents)?;
        say!("[INFO] Wrote {}", bat.display());
        bat
    } else {
        index_path.clone()
    };

    // 3. Build the manifest with the absolute host path (JSON-escaped).
    let manifest = MANIFEST_TMPL.replace("HOST_PATH", &json_escape(&host_path.to_string_lossy()));
    let manifest_file = format!("{HOST_NAME}.json");

    // Keep a copy in the install dir (handy for debugging / Windows registry target).
    let local_manifest = dir.join(&manifest_file);
    write_file(&local_manifest, &manifest)?;

    if cfg!(windows) {
        register_windows(&local_manifest)?;
    } else {
        register_unix(&manifest_file, &manifest)?;
    }

    verify(&dir, &host_path, &node);

    banner("✅ Installed");
    say!("Restart your browser completely, then use the Local TCP extension.");
    say!("Tip: the extension popup's bridge check should report version from index.js.");
    Ok(())
}

// --- Uninstall ---
// Every step records what actually happened instead of assuming it worked: a
// half-removed host (registry entry still pointing at a deleted directory) is
// worse than a clean failure, because the browser keeps trying to launch it.
fn uninstall() -> Result<(), String> {
    banner(&format!("Local TCP Bridge — Uninstaller v{VERSION}"));

    // Resolve the directory BEFORE anything else: this function calls
    // remove_dir_all, and an unresolved (relative) path would delete whatever
    // sits under the current working directory instead.
    let dir = resolved_install_dir()?;
    let manifest_file = format!("{HOST_NAME}.json");
    let mut problems: Vec<String> = Vec::new();

    if cfg!(windows) {
        unregister_windows(&mut problems);
    } else {
        let mut found = false;
        for d in browser_nm_dirs() {
            let f = d.join(&manifest_file);
            if !f.exists() {
                continue;
            }
            found = true;
            match fs::remove_file(&f) {
                Ok(()) => say!("[INFO] Removed {}", f.display()),
                Err(e) => fail(&mut problems, format!("could not remove {}: {e}", f.display())),
            }
        }
        if !found {
            say!("[INFO] No browser registrations found — nothing to unregister.");
        }
    }

    if dir.exists() {
        match fs::remove_dir_all(&dir) {
            Ok(()) => say!("[INFO] Removed {}", dir.display()),
            Err(e) => {
                fail(&mut problems, format!("could not remove {}: {e}", dir.display()));
                say!("[HINT] Close your browser completely and run this uninstaller again —");
                say!("       a running bridge process can hold these files open.");
            }
        }
    } else {
        say!("[INFO] Nothing installed at {} — already clean.", dir.display());
    }

    verify_removal(&dir, &manifest_file, &mut problems);

    if !problems.is_empty() {
        return Err(format!("uninstall finished with {} problem(s) — see the [FAIL] lines above", problems.len()));
    }

    banner("✅ Uninstalled");
    say!("Restart your browser to finish removing the host.");
    Ok(())
}

// Record a failure and report it once, where it was found.
fn fail(problems: &mut Vec<String>, msg: String) {
    warn!("  [FAIL] {msg}");
    problems.push(msg);
}

// Has this path already been reported by the step that tried to delete it?
// Keeps "could not remove X" from being echoed as "X still exists".
fn already_reported(problems: &[String], path: &Path) -> bool {
    let p = path.display().to_string();
    problems.iter().any(|existing| existing.contains(&p))
}

// --- Post-uninstall verification --------------------------------------------
// Confirms nothing was left behind, rather than trusting that each delete
// silently succeeded.
fn verify_removal(dir: &Path, manifest_file: &str, problems: &mut Vec<String>) {
    say!("");
    say!("[CHECK] Verifying the removal");
    let clean_so_far = problems.is_empty();

    if !dir.exists() {
        say!("  [OK]   install directory is gone");
    } else if !already_reported(problems, dir) {
        fail(problems, format!("{} still exists", dir.display()));
    }

    for d in browser_nm_dirs() {
        let f = d.join(manifest_file);
        if f.exists() && !already_reported(problems, &f) {
            fail(problems, format!("{} still exists", f.display()));
        }
    }

    #[cfg(windows)]
    for key in windows_reg_keys() {
        if reg_key_exists(&key) {
            fail(problems, format!("registry key {key} is still registered"));
        }
    }

    if problems.is_empty() {
        say!("  [OK]   no registrations left behind");
        say!("[OK] All checks passed.");
    } else if clean_so_far {
        // Nothing errored during removal, yet something survived.
        warn!("[WARN] Some items could not be verified as removed.");
    }
}

// --- Post-install verification ----------------------------------------------
// Cheap, but it turns "the window flashed and I have no idea what happened"
// into an explicit pass/fail list that also lands in the log file.
fn verify(dir: &Path, host_path: &Path, node: &str) {
    say!("");
    say!("[CHECK] Verifying the installation");
    let mut ok = true;

    // On Unix host_path *is* index.js, so skip the duplicate line.
    let mut expected = vec![dir.join("index.js"), dir.join(format!("{HOST_NAME}.json"))];
    if !expected.contains(&host_path.to_path_buf()) {
        expected.push(host_path.to_path_buf());
    }
    for f in expected {
        if f.exists() {
            say!("  [OK]   {}", f.display());
        } else {
            ok = false;
            warn!("  [FAIL] missing {}", f.display());
        }
    }

    match Command::new(node).arg("--version").output() {
        Ok(o) if o.status.success() => {
            say!("  [OK]   node {} responds", String::from_utf8_lossy(&o.stdout).trim());
        }
        _ => {
            ok = false;
            warn!("  [FAIL] {node} did not run — the Node.js install looks broken");
        }
    }

    #[cfg(windows)]
    {
        let key = format!(r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}");
        match reg_value(&key, None) {
            Some(v) => say!("  [OK]   registry -> {v}"),
            None => {
                ok = false;
                warn!("  [FAIL] could not read back {key}");
            }
        }
    }

    if ok {
        say!("[OK] All checks passed.");
    } else {
        warn!("[WARN] Some checks failed — see the lines marked [FAIL] above.");
    }
}

// --- Browser registration (macOS / Linux) ---
fn register_unix(manifest_file: &str, manifest: &str) -> Result<(), String> {
    let mut wrote = 0usize;
    for d in browser_nm_dirs() {
        // Write to a browser's host dir only if that browser's profile root
        // exists (so we don't litter dirs for browsers that aren't installed) —
        // except Chrome's, which we always create since it's the primary target.
        let is_primary = d.to_string_lossy().contains("Google/Chrome/")
            || d.to_string_lossy().contains("google-chrome/");
        let parent_exists = d.parent().map(|p| p.exists()).unwrap_or(false);
        if !is_primary && !parent_exists {
            continue;
        }
        if let Err(e) = fs::create_dir_all(&d) {
            warn!("[WARN] skip {}: {e}", d.display());
            continue;
        }
        let f = d.join(manifest_file);
        if write_file(&f, manifest).is_ok() {
            say!("[INFO] Registered: {}", f.display());
            wrote += 1;
        }
    }
    if wrote == 0 {
        return Err("could not register the host with any browser".to_string());
    }
    Ok(())
}

// --- Browser registration (Windows registry) ---
fn register_windows(manifest_path: &Path) -> Result<(), String> {
    let value = manifest_path.to_string_lossy().to_string();
    let mut ok = 0usize;
    for key in windows_reg_keys() {
        // .output() rather than .status(): reg.exe's chatter stays out of our
        // console, and its diagnostics are available when a write fails.
        match Command::new("reg")
            .args(["add", &key, "/ve", "/t", "REG_SZ", "/d", &value, "/f"])
            .output()
        {
            Ok(o) if o.status.success() => {
                say!("[INFO] Registered: {key}");
                ok += 1;
            }
            Ok(o) => warn!("[WARN] could not write {key}: {}", String::from_utf8_lossy(&o.stderr).trim()),
            Err(e) => warn!("[WARN] could not run reg.exe for {key}: {e}"),
        }
    }
    if ok == 0 {
        return Err("failed to register the host in the Windows registry".to_string());
    }
    Ok(())
}

fn unregister_windows(problems: &mut Vec<String>) {
    for key in windows_reg_keys() {
        // reg.exe exits non-zero both for "key not found" and for a genuine
        // failure, so probe first. Claiming removal after a failed delete would
        // leave the browser launching a host we've just deleted the files for.
        if !reg_key_exists(&key) {
            say!("[INFO] Not registered (nothing to do): {key}");
            continue;
        }
        match Command::new("reg").args(["delete", &key, "/f"]).output() {
            Ok(o) if o.status.success() => say!("[INFO] Removed registry key: {key}"),
            Ok(o) => fail(
                problems,
                format!("could not delete {key}: {}", String::from_utf8_lossy(&o.stderr).trim()),
            ),
            Err(e) => fail(problems, format!("could not run reg.exe for {key}: {e}")),
        }
    }
}

// Not cfg-gated: unregister_windows() is compiled on every platform (it's
// reached through a runtime `cfg!`, not a #[cfg] attribute).
fn reg_key_exists(key: &str) -> bool {
    Command::new("reg")
        .args(["query", key])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn windows_reg_keys() -> Vec<String> {
    [
        r"HKCU\Software\Google\Chrome\NativeMessagingHosts",
        r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts",
        r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        r"HKCU\Software\Chromium\NativeMessagingHosts",
    ]
    .iter()
    .map(|base| format!(r"{base}\{HOST_NAME}"))
    .collect()
}

// Read a registry value with reg.exe. `name` = None reads the default value.
#[cfg(windows)]
fn reg_value(key: &str, name: Option<&str>) -> Option<String> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", key]);
    match name {
        Some(n) => cmd.args(["/v", n]),
        None => cmd.arg("/ve"),
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // Lines look like "    Path    REG_EXPAND_SZ    C:\foo;C:\bar". The value can
    // contain spaces, so split on the type token rather than on whitespace.
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    for line in text.lines() {
        for ty in ["REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_SZ"] {
            if let Some(i) = line.find(ty) {
                let v = line[i + ty.len()..].trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

// --- Platform paths ---
// `install_dir()` builds its path from APPDATA (Windows) or HOME (Unix). If
// either is unset those degrade to a *relative* path, which would make
// create_dir_all install somewhere the browser can never find it and — far
// worse — make the uninstaller's remove_dir_all target whatever happens to sit
// under the current working directory. Refuse to act on a path we can't resolve.
fn resolved_install_dir() -> Result<PathBuf, String> {
    let dir = install_dir();
    if dir.as_os_str().is_empty() || dir.is_relative() {
        return Err(format!(
            "could not determine your user data directory — {} is not set",
            if cfg!(windows) { "APPDATA" } else { "HOME" }
        ));
    }
    Ok(dir)
}

fn install_dir() -> PathBuf {
    let home = home_dir();
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/LocalTCP")
    } else if cfg!(windows) {
        PathBuf::from(env::var("APPDATA").unwrap_or_default())
            .join("Algoramming")
            .join("LocalTCP")
    } else {
        home.join(".local/lib/algoramming/localtcp")
    }
}

// Native-messaging host directories for Chromium-family browsers (Unix only).
fn browser_nm_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut v = Vec::new();
    if cfg!(target_os = "macos") {
        let base = home.join("Library/Application Support");
        v.push(base.join("Google/Chrome/NativeMessagingHosts"));
        v.push(base.join("Google/Chrome Beta/NativeMessagingHosts"));
        v.push(base.join("Google/Chrome Canary/NativeMessagingHosts"));
        v.push(base.join("Chromium/NativeMessagingHosts"));
        v.push(base.join("Microsoft Edge/NativeMessagingHosts"));
        v.push(base.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"));
    } else if cfg!(target_os = "linux") {
        let c = home.join(".config");
        v.push(c.join("google-chrome/NativeMessagingHosts"));
        v.push(c.join("chromium/NativeMessagingHosts"));
        v.push(c.join("microsoft-edge/NativeMessagingHosts"));
        v.push(c.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"));
    }
    v
}

fn home_dir() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(env::var("USERPROFILE").unwrap_or_default())
    } else {
        PathBuf::from(env::var("HOME").unwrap_or_default())
    }
}

// --- Node detection ---
fn find_node() -> Option<String> {
    // 1. Whatever the inherited PATH resolves to.
    if let Some(p) = locate("node") {
        return Some(p);
    }
    // 2. Windows only: PATH as *persisted in the registry*. Explorer inherits a
    //    snapshot of the environment from sign-in, so a Node.js installed since
    //    then is invisible to `where` yet perfectly usable.
    #[cfg(windows)]
    if let Some(p) = node_from_persisted_path() {
        return Some(p);
    }
    // 3. Known install locations.
    known_node_locations().into_iter().find(|c| Path::new(c).exists())
}

// Resolve a command through the system locator (`where` / `which`).
fn locate(cmd: &str) -> Option<String> {
    let locator = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(locator).arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let hits: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|p| !p.is_empty() && Path::new(p).exists())
        .collect();
    // Prefer a real .exe on Windows: `where` also reports .cmd/.bat shims, and
    // invoking one of those from run_bridge.bat without `call` would hand over
    // control instead of returning, breaking exit-code propagation to Chrome.
    if cfg!(windows) {
        if let Some(exe) = hits.iter().find(|p| p.to_lowercase().ends_with(".exe")) {
            return Some(exe.clone());
        }
    }
    hits.into_iter().next()
}

#[cfg(windows)]
fn known_node_locations() -> Vec<String> {
    let mut v = Vec::new();

    // Fixed layouts: machine- and user-scope MSI (incl. winget), Volta,
    // Chocolatey and Scoop.
    for (var, tail) in [
        ("ProgramFiles", r"nodejs\node.exe"),
        ("ProgramFiles(x86)", r"nodejs\node.exe"),
        ("LOCALAPPDATA", r"Programs\nodejs\node.exe"),
        ("LOCALAPPDATA", r"Volta\bin\node.exe"),
        ("ProgramData", r"chocolatey\bin\node.exe"),
        ("USERPROFILE", r"scoop\shims\node.exe"),
    ] {
        if let Ok(base) = env::var(var) {
            if !base.is_empty() {
                v.push(format!(r"{base}\{tail}"));
            }
        }
    }

    // Version managers keep every release in its own directory, so scan them.
    // (nvm-windows: <root>\v20.11.0\node.exe, fnm: <root>\v20.11.0\installation\node.exe)
    for (var, sub, tail) in [
        ("APPDATA", r"nvm", ""),
        ("ProgramData", r"nvm", ""),
        ("LOCALAPPDATA", r"fnm\node-versions", "installation"),
    ] {
        let Ok(base) = env::var(var) else { continue };
        if base.is_empty() {
            continue;
        }
        let Ok(entries) = fs::read_dir(Path::new(&base).join(sub)) else { continue };
        for e in entries.flatten() {
            let mut p = e.path();
            if !tail.is_empty() {
                p = p.join(tail);
            }
            p = p.join("node.exe");
            if p.exists() {
                v.push(p.to_string_lossy().into_owned());
            }
        }
    }

    v
}

#[cfg(not(windows))]
fn known_node_locations() -> Vec<String> {
    ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[cfg(windows)]
fn node_from_persisted_path() -> Option<String> {
    let mut dirs: Vec<String> = Vec::new();
    for key in [
        r"HKCU\Environment",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    ] {
        if let Some(raw) = reg_value(key, Some("Path")) {
            dirs.extend(expand_env(&raw).split(';').map(|s| s.trim().to_string()));
        }
    }
    dirs.into_iter()
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(&d).join("node.exe"))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

// Minimal %VAR% expansion, enough for the REG_EXPAND_SZ PATH values above.
#[cfg(windows)]
fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('%') {
            Some(close) => {
                let name = &after[..close];
                match env::var(name) {
                    Ok(v) => out.push_str(&v),
                    // Unknown variable: leave it verbatim rather than dropping a
                    // path segment and silently mis-joining the neighbours.
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

// --- Automatic Node.js install (Windows) -------------------------------------
// Restores what the old PowerShell installer did: if Node is missing, install it
// with winget instead of dead-ending the user.
#[cfg(windows)]
fn install_node_automatically() -> Option<String> {
    if locate("winget").is_none() {
        warn!("[WARN] winget is unavailable, so Node.js can't be installed automatically.");
        return None;
    }
    say!("[INFO] Installing Node.js LTS with winget — this can take a few minutes.");
    say!("       Approve the Windows permission prompt if one appears.");
    match Command::new("winget")
        .args([
            "install",
            "--id",
            "OpenJS.NodeJS.LTS",
            "--exact",
            "--source",
            "winget",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .status()
    {
        Ok(s) if s.success() => say!("[OK] winget reported Node.js as installed."),
        Ok(s) => warn!("[WARN] winget exited with {s} — checking for Node anyway."),
        Err(e) => {
            warn!("[WARN] could not run winget: {e}");
            return None;
        }
    }
    // winget updates the *persisted* PATH; this process's copy is stale, so look
    // at the registry and the known locations rather than re-running `where`.
    node_from_persisted_path()
        .or_else(|| known_node_locations().into_iter().find(|c| Path::new(c).exists()))
}

#[cfg(not(windows))]
fn install_node_automatically() -> Option<String> {
    None
}

fn node_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install it with Homebrew: `brew install node`, or from https://nodejs.org/"
    } else if cfg!(windows) {
        "Install it with `winget install OpenJS.NodeJS.LTS`, or from https://nodejs.org/"
    } else {
        "Install it via your package manager (e.g. `sudo apt install nodejs`), or from https://nodejs.org/"
    }
}

// --- Small utilities ---
fn patch_shebang(src: &str, node: &str) -> String {
    let rest = src.find('\n').map(|i| &src[i + 1..]).unwrap_or("");
    format!("#!{node}\n{rest}")
}

fn json_escape(s: &str) -> String {
    // Enough for filesystem paths embedded in JSON: backslashes and quotes.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = fs::set_permissions(path, perm);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn banner(title: &str) {
    say!("\n----------------------------------------------------");
    say!(" {title}");
    say!("----------------------------------------------------");
}
