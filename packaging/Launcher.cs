using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:8787/";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (!File.Exists(Path.Combine(root, "server.mjs"))) root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ropiq") + Path.DirectorySeparatorChar;
        string node = Path.Combine(root, "runtime", "node.exe");
        string server = Path.Combine(root, "server.mjs");
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ropiq");
        try
        {
            if (!IsReady())
            {
                if (!File.Exists(node) || !File.Exists(server)) throw new FileNotFoundException("安装文件不完整，请重新安装 Ropiq。");
                Directory.CreateDirectory(data);
                ProcessStartInfo info = new ProcessStartInfo(node, "\"" + server + "\"");
                info.WorkingDirectory = root;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                info.EnvironmentVariables["ROPIQ_DATA_DIR"] = data;
                Process.Start(info);
                for (int i = 0; i < 120 && !IsReady(); i++) Thread.Sleep(250);
            }
            if (!IsReady()) throw new Exception("Ropiq 服务未能启动。请确认 8787 端口未被其他程序占用。");
            ProcessStartInfo browser = new ProcessStartInfo(Url);
            browser.UseShellExecute = true;
            Process.Start(browser);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Ropiq 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static bool IsReady()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Url);
            request.Timeout = 800;
            request.ReadWriteTimeout = 800;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }
}
