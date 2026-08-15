using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class InstallForm : Form
{
    private readonly Button installButton = new Button();
    private readonly CheckBox desktopShortcut = new CheckBox();
    private readonly Label status = new Label();

    internal InstallForm()
    {
        Text = "安装 Ropiq";
        ClientSize = new Size(560, 360);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 21, 30);
        ForeColor = Color.FromArgb(238, 244, 243);
        Font = new Font("Microsoft YaHei UI", 9F);

        Label brand = NewLabel("ROPIQ", 34, 28, 480, 28, 18F, FontStyle.Bold, Color.FromArgb(255, 176, 106));
        Label title = NewLabel("AI 短剧与商品视频制作智能体", 34, 70, 480, 32, 16F, FontStyle.Bold, ForeColor);
        Label copy = NewLabel("安装后直接打开制作台。支持自选大模型 API、本地或云端生成后端、17 阶段短剧制作与安全扩展。", 34, 114, 480, 55, 9F, FontStyle.Regular, Color.FromArgb(150, 166, 176));
        desktopShortcut.Text = "创建桌面快捷方式";
        desktopShortcut.Checked = true;
        desktopShortcut.SetBounds(34, 196, 300, 26);
        desktopShortcut.ForeColor = ForeColor;
        desktopShortcut.BackColor = BackColor;
        status.Text = "安装位置：" + TargetDirectory();
        status.SetBounds(34, 237, 490, 38);
        status.ForeColor = Color.FromArgb(112, 216, 207);
        installButton.Text = "安装并打开";
        installButton.SetBounds(380, 294, 144, 40);
        installButton.FlatStyle = FlatStyle.Flat;
        installButton.FlatAppearance.BorderColor = Color.FromArgb(255, 176, 106);
        installButton.BackColor = Color.FromArgb(255, 176, 106);
        installButton.ForeColor = Color.FromArgb(36, 18, 7);
        installButton.Click += Install;
        Controls.AddRange(new Control[] { brand, title, copy, desktopShortcut, status, installButton });
    }

    private Label NewLabel(string text, int x, int y, int width, int height, float size, FontStyle style, Color color)
    {
        Label label = new Label();
        label.Text = text;
        label.SetBounds(x, y, width, height);
        label.Font = new Font("Microsoft YaHei UI", size, style);
        label.ForeColor = color;
        return label;
    }

    private void Install(object sender, EventArgs args)
    {
        installButton.Enabled = false;
        status.Text = "正在安装，请稍候…";
        Application.DoEvents();
        try
        {
            string target = TargetDirectory();
            StopServer(target);
            string temp = Path.Combine(Path.GetTempPath(), "Ropiq-Install-" + Guid.NewGuid().ToString("N"));
            string zip = temp + ".zip";
            Directory.CreateDirectory(temp);
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Ropiq.Payload.zip"))
            using (FileStream destination = File.Create(zip)) source.CopyTo(destination);
            ZipFile.ExtractToDirectory(zip, temp);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            string backup = null;
            if (Directory.Exists(target))
            {
                backup = target + ".previous-" + Guid.NewGuid().ToString("N");
                Directory.Move(target, backup);
            }
            try
            {
                Directory.Move(temp, target);
                if (backup != null) Directory.Delete(backup, true);
            }
            catch
            {
                if (Directory.Exists(target)) Directory.Delete(target, true);
                if (backup != null && Directory.Exists(backup)) Directory.Move(backup, target);
                throw;
            }
            File.Delete(zip);
            CreateShortcuts(target, desktopShortcut.Checked);
            RegisterUninstaller(target);
            status.Text = "安装完成，正在打开配置向导…";
            Application.DoEvents();
            Process.Start(Path.Combine(target, "Ropiq.exe"));
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception error)
        {
            status.Text = "安装失败：" + error.Message;
            installButton.Enabled = true;
            MessageBox.Show(error.Message, "Ropiq 安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal void RunSilent()
    {
        desktopShortcut.Checked = true;
        Install(this, EventArgs.Empty);
    }

    private static string TargetDirectory()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ropiq");
    }

    private static void CreateShortcuts(string target, bool desktop)
    {
        string group = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Ropiq");
        if (Directory.Exists(group)) Directory.Delete(group, true);
        Directory.CreateDirectory(group);
        File.Copy(Path.Combine(target, "Ropiq.exe"), Path.Combine(group, "Ropiq.exe"), true);
        File.WriteAllText(Path.Combine(group, "Ropiq 新手说明.url"), "[InternetShortcut]\r\nURL=" + new Uri(Path.Combine(target, "public", "guide.html")).AbsoluteUri + "\r\n");
        File.Copy(Path.Combine(target, "RopiqUninstall.exe"), Path.Combine(group, "卸载 Ropiq.exe"), true);
        string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Ropiq.lnk");
        string desktopLauncher = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Ropiq.exe");
        if (File.Exists(desktopLink)) File.Delete(desktopLink);
        if (File.Exists(desktopLauncher)) File.Delete(desktopLauncher);
        if (desktop) File.Copy(Path.Combine(target, "Ropiq.exe"), desktopLauncher, true);
    }

    private static void RegisterUninstaller(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Ropiq"))
        {
            key.SetValue("DisplayName", "Ropiq");
            key.SetValue("DisplayVersion", "0.4.0-alpha.10");
            key.SetValue("Publisher", "Ropiq Open Source Project");
            key.SetValue("InstallLocation", target);
            key.SetValue("UninstallString", "\"" + Path.Combine(target, "RopiqUninstall.exe") + "\"");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    private static void StopServer(string target)
    {
        string expectedLauncher = Path.Combine(target, "Ropiq.exe");
        foreach (Process launcher in Process.GetProcessesByName("Ropiq"))
        {
            try
            {
                if (string.Equals(launcher.MainModule.FileName, expectedLauncher, StringComparison.OrdinalIgnoreCase))
                {
                    launcher.Kill();
                    launcher.WaitForExit(5000);
                }
            }
            catch { }
        }
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

internal static class Installer
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        InstallForm form = new InstallForm();
        if (args.Length > 0 && string.Equals(args[0], "/S", StringComparison.OrdinalIgnoreCase)) form.RunSilent();
        else Application.Run(form);
    }
}
