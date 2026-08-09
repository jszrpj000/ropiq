using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Uninstall
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        string target = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        if (args.Length == 0)
        {
            if (MessageBox.Show("确定卸载 Ropiq？本机设置和密钥将保留，可在以后重新安装时继续使用。", "卸载 Ropiq", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            string copy = Path.Combine(Path.GetTempPath(), "Ropiq-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Application.ExecutablePath, copy);
            Process.Start(copy, "\"" + target + "\"");
            return;
        }
        target = Path.GetFullPath(args[0]);
        string expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ropiq");
        if (!string.Equals(target, expected, StringComparison.OrdinalIgnoreCase))
        {
            MessageBox.Show("拒绝删除非标准安装目录。", "Ropiq", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        StopServer(target);
        string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Ropiq");
        string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Ropiq.lnk");
        try { if (Directory.Exists(startMenu)) Directory.Delete(startMenu, true); } catch { }
        try { if (File.Exists(desktop)) File.Delete(desktop); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Ropiq", false); } catch { }
        try { if (Directory.Exists(target)) Directory.Delete(target, true); }
        catch (Exception error) { MessageBox.Show("卸载未完成：" + error.Message, "Ropiq", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        MessageBox.Show("Ropiq 已卸载。用户设置保留在 LocalAppData\\Ropiq。", "Ropiq", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static void StopServer(string target)
    {
        string processFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ropiq", "server.json");
        if (!File.Exists(processFile)) return;
        try
        {
            Match match = Regex.Match(File.ReadAllText(processFile), "\\\"pid\\\"\\s*:\\s*(\\d+)");
            if (!match.Success) return;
            Process process = Process.GetProcessById(int.Parse(match.Groups[1].Value));
            string expectedNode = Path.Combine(target, "runtime", "node.exe");
            if (string.Equals(process.MainModule.FileName, expectedNode, StringComparison.OrdinalIgnoreCase))
            {
                process.Kill();
                process.WaitForExit(5000);
            }
        }
        catch { }
    }
}
