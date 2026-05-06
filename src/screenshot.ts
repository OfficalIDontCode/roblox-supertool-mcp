/**
 * Capture a screenshot of the Roblox Studio window using PowerShell + GDI.
 * Returns a path to the saved PNG.
 *
 * Studio plugins cannot capture the viewport directly, so we go through
 * the OS: locate the Studio window by title, optionally focus it, then
 * BitBlt its client area to a bitmap.
 */
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

export type ScreenshotResult = {
  ok: boolean;
  path?: string;
  width?: number;
  height?: number;
  windowTitle?: string;
  error?: string;
};

export type ScreenshotOptions = {
  outputPath?: string;
  windowTitleMatch?: string;
  region?: "full" | "viewport";
};

function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error(`PowerShell timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ps.stdout.on("data", (d) => (stdout += d.toString()));
    ps.stderr.on("data", (d) => (stderr += d.toString()));
    ps.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`PowerShell exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

export async function captureStudioWindow(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const titleMatch = opts.windowTitleMatch ?? "Roblox Studio";
  const tmpDir = path.join(os.tmpdir(), "roblox-supertool-screenshots");
  await fs.mkdir(tmpDir, { recursive: true });
  const outPath = opts.outputPath ?? path.join(tmpDir, `studio-${Date.now()}.png`);
  const safeTitle = titleMatch.replace(/'/g, "''");
  const safeOut = outPath.replace(/'/g, "''");

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObj);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'Win32').Type) {
  Add-Type -TypeDefinition $source
}

$found = [IntPtr]::Zero
$foundTitle = ''
$matchText = '${safeTitle}'
$proc = [Win32+EnumWindowsProc] {
  param($hWnd, $lParam)
  if ([Win32]::IsWindowVisible($hWnd)) {
    $len = [Win32]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
      $title = $sb.ToString()
      if ($title -like "*$matchText*") {
        $script:found = $hWnd
        $script:foundTitle = $title
        return $false
      }
    }
  }
  return $true
}
[void][Win32]::EnumWindows($proc, [IntPtr]::Zero)

if ($found -eq [IntPtr]::Zero) {
  Write-Output 'NOTFOUND'
  exit 1
}

if ([Win32]::IsIconic($found)) { [void][Win32]::ShowWindow($found, 9) ; Start-Sleep -Milliseconds 250 }

$rect = New-Object Win32+RECT
[void][Win32]::GetWindowRect($found, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Output 'BADSIZE'; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (0x2) forces full render even when occluded; also works for DWM-composited windows
$ok = [Win32]::PrintWindow($found, $hdc, 0x2)
$g.ReleaseHdc($hdc)
if (-not $ok) {
  # Fallback to CopyFromScreen
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
}
$g.Dispose()
$bmp.Save('${safeOut}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output ("OK|" + $w + "|" + $h + "|" + $foundTitle)
`;

  try {
    const out = await runPowerShell(script, 15_000);
    if (out.startsWith("NOTFOUND")) {
      return { ok: false, error: `No window matching '${titleMatch}' found. Is Roblox Studio open?` };
    }
    if (out.startsWith("BADSIZE")) {
      return { ok: false, error: "Studio window has invalid size (minimized?)" };
    }
    const match = out.match(/^OK\|(\d+)\|(\d+)\|(.+)$/m);
    if (!match) return { ok: false, error: `Unexpected PowerShell output: ${out.slice(0, 200)}` };
    return {
      ok: true,
      path: outPath,
      width: parseInt(match[1], 10),
      height: parseInt(match[2], 10),
      windowTitle: match[3].trim(),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function listStudioWindows(): Promise<{ windows: { title: string; visible: boolean }[] }> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$procs = Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and ($_.ProcessName -like '*RobloxStudio*' -or $_.MainWindowTitle -like '*Roblox*') }
$procs | ForEach-Object { '{0}|{1}' -f $_.MainWindowTitle, $_.ProcessName } | Out-String
`;
  try {
    const out = await runPowerShell(script, 5_000);
    const windows = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const [title] = l.split("|");
        return { title, visible: true };
      });
    return { windows };
  } catch {
    return { windows: [] };
  }
}
