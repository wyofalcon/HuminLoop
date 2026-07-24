
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Run() {
    var rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      rows.Add(pid.ToString() + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@ -ErrorAction SilentlyContinue
$names = @{}
Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }
[WinEnum]::Run() | ForEach-Object {
  $parts = $_.Split('|', 2)
  $pn = $names[[int]$parts[0]]
  "$($parts[0])|$pn|$($parts[1])"
}
