// Where Chrome is, how it is launched, and how it is ended — per platform.
//
// `cdp.mjs` hard-codes a Windows Chrome path AND disposes of Chrome through
// `taskkill` and a PowerShell sweep, neither of which exists in a container.
// Cleanup failure is the path that orphans a profile directory, and the
// retirement record holds one such profile at 92 MB, so the lifecycle is
// injected rather than only the path (design.md D9).
//
// Nothing here imports `cdp.mjs`: `cdp.mjs` imports this and re-exports the
// Windows pieces, so the runners this change does not convert see byte-
// identical behaviour.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WINDOWS_CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

// The Windows settle before the profile is removed. A Chrome still holding
// files in the profile is what makes the removal fail, so whoever ends the
// browser owns the settling time.
const WINDOWS_SETTLE_MS = 1500;

// The Linux grace between SIGTERM and SIGKILL. New with this change, and the
// same order as the Windows settle above for the same reason: a browser given
// no time to exit leaves the files that make the profile removal fail.
const LINUX_TERM_GRACE_MS = 5000;

function removeProfile(profile) {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  return !fs.existsSync(profile);
}

export const windowsChrome = {
  name: 'windows',

  locate: () => WINDOWS_CHROME,

  launch(args, options = {}) {
    return spawn(WINDOWS_CHROME, args, options);
  },

  /**
   * End THIS RUN'S Chrome AND NOTHING ELSE, then take its profile directory
   * with it. Never widen either kill to `/IM chrome.exe`: that ends every
   * Chrome on the machine, the developer's own windows included, mid-run and
   * with no warning.
   *
   * Two scopes, both narrow. The tree rooted at the process we spawned is the
   * run — the extra `--new-window` launches hand their window to that same
   * browser process and exit, so `/T` reaches them. The profile sweep is the
   * backstop for a browser that outlived its launcher, and it can only ever
   * match this run because the `--user-data-dir` is a throwaway made for it.
   */
  async dispose(child, profile) {
    if (child && child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' }
    );
    await sleep(WINDOWS_SETTLE_MS);
    return { platform: 'windows', profileRemoved: removeProfile(profile) };
  },

  settleMs: WINDOWS_SETTLE_MS,
};

export const linuxChrome = {
  name: 'linux',

  locate: () => process.env.APP_CHROME ?? '/usr/bin/google-chrome',

  // `detached` puts Chrome in its own process group, which is what makes the
  // negative-pid signal below reach its renderers as well as the browser
  // process. Without it a disposal ends the parent and leaves the children.
  launch(args, options = {}) {
    return spawn(this.locate(), args, { detached: true, ...options });
  },

  /**
   * SIGTERM the group, wait, SIGKILL, then take the profile. It REPORTS what
   * happened rather than returning quietly: the container runner that cannot
   * dispose of its browser is the one that orphans a profile, and a disposal
   * whose failure is silent is indistinguishable from one that worked.
   */
  async dispose(child, profile) {
    const report = { platform: 'linux', signalled: false, exited: false, killed: false, profileRemoved: false, error: null };
    if (child && child.pid) {
      const signal = (name) => {
        try {
          process.kill(-child.pid, name);
          return true;
        } catch (error) {
          // ESRCH is an already-dead child, which is a successful disposal.
          if (error?.code === 'ESRCH') return false;
          try {
            process.kill(child.pid, name);
            return true;
          } catch (inner) {
            if (inner?.code !== 'ESRCH') report.error = inner.message;
            return false;
          }
        }
      };
      report.signalled = signal('SIGTERM');
      const until = Date.now() + LINUX_TERM_GRACE_MS;
      while (Date.now() < until) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await sleep(100);
      }
      report.exited = child.exitCode !== null || child.signalCode !== null;
      if (!report.exited) report.killed = signal('SIGKILL');
    }
    report.profileRemoved = removeProfile(profile);
    return report;
  },

  settleMs: LINUX_TERM_GRACE_MS,
};

/**
 * `APP_BROWSER_PLATFORM` overrides the detection, so the container's adapter
 * can be exercised from a host that is not Linux and the choice is recorded in
 * a manifest rather than inferred at read time.
 */
export function selectBrowserPlatform({ platform = process.platform, override = process.env.APP_BROWSER_PLATFORM } = {}) {
  const requested = override ?? (platform === 'win32' ? 'windows' : 'linux');
  if (requested === 'windows') return windowsChrome;
  if (requested === 'linux') return linuxChrome;
  throw new Error(`unknown browser platform: ${JSON.stringify(requested)}`);
}
