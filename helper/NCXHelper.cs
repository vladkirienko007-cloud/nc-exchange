// NC Exchange помощник: по горячей клавише снимает шапку и карточки выбранного актива
// из окна MTA и отдаёт снимки сайту биржи через 127.0.0.1. Распознаёт и сохраняет сайт.
// Сборка: helper/build.cmd (компилятор C# есть в любой Windows 10/11, ставить ничего не надо).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Media;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("NC Exchange помощник")]
[assembly: System.Reflection.AssemblyProduct("NC Exchange помощник")]
[assembly: System.Reflection.AssemblyVersion("1.2.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.2.1.0")]

static class Program
{
    public const string Version = "1.2.1";
    public const string Site = "https://vladkirienko007-cloud.github.io/nc-exchange/#/helper";

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        bool created;
        using (var m = new Mutex(true, "NCXHelper_single_instance_" + Bridge.Port, out created))
        {
            if (!created)
            {
                MessageBox.Show("Помощник уже запущен — его значок в трее, рядом с часами.", "NC Exchange помощник");
                return;
            }
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HelperApp());
        }
    }
}

/* ---------------- настройки ---------------- */

// Рамки для одного разрешения — доли клиентской области окна игры (x, y, ширина, высота).
class Frames
{
    public RectangleF Header, Cards; // Cards пустой — карточки не найдены
    public bool Manual;               // поставлены руками в «Настроить рамки»
}

class Settings
{
    // Начальные рамки для ручной настройки — планшет NC PAD при 16:9
    public static readonly RectangleF DefHeader = new RectangleF(0.325f, 0.338f, 0.325f, 0.068f);
    public static readonly RectangleF DefCards = new RectangleF(0.325f, 0.700f, 0.325f, 0.143f);

    // Ключ — разрешение окна игры («1920x1080»). Нет рамок — первый снимок уходит на сайт
    // целиком, и сайт сам находит на нём шапку и карточки.
    public Dictionary<string, Frames> PerRes = new Dictionary<string, Frames>();
    public bool CardsOn = true;
    public bool Sound = true;
    public bool Plaque = true;
    public bool Samples = true;
    public Keys Hotkey = Keys.F9;
    static readonly string[] BaseOrigins = { "https://vladkirienko007-cloud.github.io", "http://localhost:8765", "http://127.0.0.1:8765" };
    public List<string> Origins = new List<string>(BaseOrigins);

    // NCX_HELPER_DIR — отдельная папка настроек для проверки, чтобы не трогать настоящие
    public static string Dir { get { return Environment.GetEnvironmentVariable("NCX_HELPER_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NCXHelper"); } }
    static string FilePath { get { return Path.Combine(Dir, "settings.ini"); } }
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static string Key(Size s) { return s.Width + "x" + s.Height; }

    static string R(RectangleF r) { return r.IsEmpty ? "-" : string.Join(",", new[] { r.X, r.Y, r.Width, r.Height }.Select(v => v.ToString("0.#####", Inv))); }
    static bool TryR(string s, out RectangleF r)
    {
        r = RectangleF.Empty;
        var p = s.Split(',');
        float[] v = new float[4];
        if (p.Length != 4) return false;
        for (int i = 0; i < 4; i++) if (!float.TryParse(p[i], NumberStyles.Float, Inv, out v[i])) return false;
        r = new RectangleF(v[0], v[1], v[2], v[3]);
        return r.Width > 0.01f && r.Height > 0.01f;
    }

    public static Settings Load()
    {
        var s = new Settings();
        try
        {
            if (!File.Exists(FilePath)) return s;
            foreach (var line in File.ReadAllLines(FilePath, Encoding.UTF8))
            {
                int i = line.IndexOf('=');
                if (i < 0 || line.StartsWith("#")) continue;
                string k = line.Substring(0, i).Trim(), v = line.Substring(i + 1).Trim();
                if (k.StartsWith("frames."))
                {
                    // frames.1920x1080=шапка;карточки[;manual]
                    var parts = v.Split(';');
                    RectangleF h, c;
                    if (parts.Length < 2 || !TryR(parts[0], out h)) continue;
                    if (!TryR(parts[1], out c)) c = RectangleF.Empty;
                    s.PerRes[k.Substring(7)] = new Frames { Header = h, Cards = c, Manual = parts.Length > 2 && parts[2] == "manual" };
                }
                else if (k == "cardsOn") s.CardsOn = v != "0";
                else if (k == "sound") s.Sound = v != "0";
                else if (k == "plaque") s.Plaque = v != "0";
                else if (k == "samples") s.Samples = v != "0";
                else if (k == "hotkey") { Keys key; if (Enum.TryParse(v, out key)) s.Hotkey = key; }
                else if (k == "origin" && v.StartsWith("http") && !s.Origins.Contains(v.TrimEnd('/'))) s.Origins.Add(v.TrimEnd('/'));
            }
        }
        catch { }
        return s;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            var lines = new List<string> {
                "cardsOn=" + (CardsOn ? 1 : 0), "sound=" + (Sound ? 1 : 0), "plaque=" + (Plaque ? 1 : 0),
                "samples=" + (Samples ? 1 : 0), "hotkey=" + Hotkey };
            foreach (var kv in PerRes)
                lines.Add("frames." + kv.Key + "=" + R(kv.Value.Header) + ";" + R(kv.Value.Cards) + (kv.Value.Manual ? ";manual" : ""));
            lines.Add("# свой адрес сайта (если ссылка сменится): origin=https://...");
            foreach (var o in Origins.Where(o => !BaseOrigins.Contains(o))) lines.Add("origin=" + o);
            File.WriteAllLines(FilePath, lines, Encoding.UTF8);
        }
        catch { }
    }
}

/* ---------------- снимок окна игры ---------------- */

static class Game
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);

    public static IntPtr Window()
    {
        foreach (var p in Process.GetProcessesByName("gta_sa"))
            if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
        return IntPtr.Zero;
    }

    public static Rectangle ClientOnScreen(IntPtr h)
    {
        RECT r; POINT p = new POINT();
        if (h == IntPtr.Zero || IsIconic(h) || !GetClientRect(h, out r) || !ClientToScreen(h, ref p)) return Rectangle.Empty;
        return new Rectangle(p.X, p.Y, r.R - r.L, r.B - r.T);
    }

    public static Bitmap Grab(Rectangle r)
    {
        var b = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(b)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);
        return b;
    }

    // В полноэкранном режиме Windows отдаёт вместо картинки игры чёрный кадр
    public static bool IsBlack(Bitmap b)
    {
        int bright = 0;
        for (int y = 1; y < 12; y++)
            for (int x = 1; x < 12; x++)
            {
                var c = b.GetPixel(b.Width * x / 12, b.Height * y / 12);
                if (Math.Max(c.R, Math.Max(c.G, c.B)) > 16) bright++;
            }
        return bright < 3;
    }

    // Уменьшенная серая копия участка экрана — по ней сравниваем кадры
    public static byte[] Signature(Bitmap b)
    {
        const int W = 64, H = 16;
        using (var small = new Bitmap(W, H, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = InterpolationMode.Bilinear;
                g.DrawImage(b, new Rectangle(0, 0, W, H));
            }
            var sig = new byte[W * H];
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                {
                    var c = small.GetPixel(x, y);
                    sig[y * W + x] = (byte)((c.R * 3 + c.G * 6 + c.B) / 10);
                }
            return sig;
        }
    }

    public static double Diff(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length) return 255;
        long d = 0;
        for (int i = 0; i < a.Length; i++) d += Math.Abs(a[i] - b[i]);
        return d / (double)a.Length;
    }

    public static Rectangle Part(Size s, RectangleF f)
    {
        var r = Rectangle.Round(new RectangleF(f.X * s.Width, f.Y * s.Height, f.Width * s.Width, f.Height * s.Height));
        r.Intersect(new Rectangle(Point.Empty, s));
        return r;
    }

    public static string Png64(Bitmap src)
    {
        using (var ms = new MemoryStream())
        {
            src.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }
    }

    public static string Png64(Bitmap src, Rectangle part)
    {
        using (var b = src.Clone(part, src.PixelFormat))
        using (var ms = new MemoryStream())
        {
            b.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }
    }
}

/* ---------------- локальный сервер для сайта ---------------- */

// Сайт (открытый в браузере на этом же ПК) раз за разом спрашивает /next и ждёт до 25 с,
// пока не появится снимок; результат распознавания присылает в /result.
class Bridge
{
    // NCX_HELPER_PORT — только для проверки новой версии рядом с запущенной
    public static readonly int Port = int.TryParse(Environment.GetEnvironmentVariable("NCX_HELPER_PORT"), out Port) ? Port : 47615;
    readonly Settings settings;
    readonly Queue<Dictionary<string, object>> jobs = new Queue<Dictionary<string, object>>();
    readonly object gate = new object();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    DateTime lastPoll = DateTime.MinValue;
    int waiting;
    public event Action<Dictionary<string, object>> Result;
    public event Action<Dictionary<string, object>> Sample;
    public string Error;

    public Bridge(Settings s) { settings = s; }

    public bool SiteConnected
    {
        get { lock (gate) return waiting > 0 || (DateTime.Now - lastPoll).TotalSeconds < 35; }
    }

    public int Pending { get { lock (gate) return jobs.Count; } }
    public bool PortError { get { return Error != null; } }

    public void Push(Dictionary<string, object> job)
    {
        lock (gate)
        {
            jobs.Enqueue(job);
            while (jobs.Count > 20) jobs.Dequeue();
            Monitor.PulseAll(gate);
        }
    }

    public void Start()
    {
        TcpListener l;
        try { l = new TcpListener(IPAddress.Loopback, Port); l.Start(); }
        catch (Exception e) { Error = "Порт " + Port + " занят: " + e.Message; return; }
        new Thread(() =>
        {
            while (true)
            {
                try
                {
                    var c = l.AcceptTcpClient();
                    new Thread(() => Serve(c)) { IsBackground = true }.Start();
                }
                catch { Thread.Sleep(200); }
            }
        }) { IsBackground = true }.Start();
    }

    void Serve(TcpClient c)
    {
        using (c)
        {
            try
            {
                c.ReceiveTimeout = 10000;
                var s = c.GetStream();
                string head = ReadHead(s);
                if (head == null) return;
                var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                var first = lines[0].Split(' ');
                if (first.Length < 2) return;
                string method = first[0], path = first[1].Split('?')[0];
                var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var ln in lines.Skip(1))
                {
                    int i = ln.IndexOf(':');
                    if (i > 0) h[ln.Substring(0, i).Trim()] = ln.Substring(i + 1).Trim();
                }
                string origin;
                h.TryGetValue("Origin", out origin);
                // отвечаем только сайту биржи: чужие страницы не должны видеть снимки игры
                bool allowed = origin != null && settings.Origins.Contains(origin.TrimEnd('/'));
                if (origin != null && !allowed) { Send(s, 403, null, "{\"error\":\"origin\"}"); return; }
                if (method == "OPTIONS") { Send(s, 204, origin, null); return; }
                if (path == "/status")
                {
                    Send(s, 200, origin, json.Serialize(new { app = "ncx-helper", version = Program.Version, game = Game.Window() != IntPtr.Zero, pending = Pending }));
                    return;
                }
                if (!allowed) { Send(s, 403, null, "{\"error\":\"origin\"}"); return; }
                if (method == "GET" && path == "/next") { Next(s, origin); return; }
                if (method == "POST" && (path == "/result" || path == "/sample"))
                {
                    int len = 0;
                    string cl;
                    if (h.TryGetValue("Content-Length", out cl)) int.TryParse(cl, out len);
                    var body = ReadBody(s, Math.Min(len, 16 << 20));
                    var r = json.Deserialize<Dictionary<string, object>>(body);
                    Send(s, 200, origin, "{}");
                    var ev = path == "/result" ? Result : Sample;
                    if (r != null && ev != null) ev(r);
                    return;
                }
                Send(s, 404, origin, "{}");
            }
            catch { }
        }
    }

    void Next(NetworkStream s, string origin)
    {
        Dictionary<string, object> job = null;
        lock (gate)
        {
            waiting++;
            lastPoll = DateTime.Now;
            var until = DateTime.Now.AddSeconds(25);
            while (jobs.Count == 0)
            {
                var left = until - DateTime.Now;
                if (left <= TimeSpan.Zero) break;
                Monitor.Wait(gate, left);
            }
            if (jobs.Count > 0) job = jobs.Dequeue();
            waiting--;
            lastPoll = DateTime.Now;
        }
        if (job == null) { Send(s, 204, origin, null); return; }
        try { Send(s, 200, origin, json.Serialize(job)); }
        catch { lock (gate) { var rest = jobs.ToList(); jobs.Clear(); jobs.Enqueue(job); foreach (var j in rest) jobs.Enqueue(j); } }
    }

    static string ReadHead(NetworkStream s)
    {
        var buf = new List<byte>();
        while (buf.Count < 16384)
        {
            int b = s.ReadByte();
            if (b < 0) return null;
            buf.Add((byte)b);
            int n = buf.Count;
            if (n >= 4 && buf[n - 4] == 13 && buf[n - 3] == 10 && buf[n - 2] == 13 && buf[n - 1] == 10)
                return Encoding.ASCII.GetString(buf.ToArray(), 0, n - 4);
        }
        return null;
    }

    static string ReadBody(NetworkStream s, int len)
    {
        var b = new byte[len];
        int got = 0;
        while (got < len) { int n = s.Read(b, got, len - got); if (n <= 0) break; got += n; }
        return Encoding.UTF8.GetString(b, 0, got);
    }

    static void Send(NetworkStream s, int code, string origin, string body)
    {
        var text = code == 200 ? "OK" : code == 204 ? "No Content" : code == 403 ? "Forbidden" : "Not Found";
        var bytes = body == null ? new byte[0] : Encoding.UTF8.GetBytes(body);
        var sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(code).Append(' ').Append(text).Append("\r\n");
        if (origin != null)
        {
            sb.Append("Access-Control-Allow-Origin: ").Append(origin).Append("\r\nVary: Origin\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n");
            sb.Append("Access-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n");
        }
        sb.Append("Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n");
        sb.Append("Content-Length: ").Append(bytes.Length).Append("\r\nConnection: close\r\n\r\n");
        var h = Encoding.ASCII.GetBytes(sb.ToString());
        s.Write(h, 0, h.Length);
        if (bytes.Length > 0) s.Write(bytes, 0, bytes.Length);
        s.Flush();
    }
}

/* ---------------- уведомление поверх игры ---------------- */

class Toast : Form
{
    readonly System.Windows.Forms.Timer hide = new System.Windows.Forms.Timer();
    string title = "", text = "";
    Color accent = Color.FromArgb(96, 165, 250);

    public Toast()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(22, 27, 38);
        Size = new Size(380, 74);
        DoubleBuffered = true;
        hide.Tick += (s, e) => { hide.Stop(); Hide(); };
        Click += (s, e) => Hide();
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08 | 0x80 | 0x08000000; // поверх всех, без кнопки в панели задач, не забирает фокус у игры
            return cp;
        }
    }

    public void Pop(string t, string s, Color c, int ms)
    {
        title = t; text = s; accent = c;
        var game = Game.ClientOnScreen(Game.Window());
        var area = game.IsEmpty ? Screen.PrimaryScreen.WorkingArea : game;
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + 44);
        Invalidate();
        if (!Visible) Show();
        hide.Stop();
        hide.Interval = ms;
        hide.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        using (var pen = new Pen(Color.FromArgb(48, 56, 72))) g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        using (var b = new SolidBrush(accent)) g.FillRectangle(b, 0, 0, 5, Height);
        using (var b = new SolidBrush(accent)) g.FillEllipse(b, 20, 27, 18, 18);
        using (var f = new Font("Segoe UI Semibold", 11f))
        using (var b = new SolidBrush(Color.FromArgb(235, 240, 248)))
            g.DrawString(title, f, b, new RectangleF(50, 12, Width - 60, 24));
        using (var f = new Font("Segoe UI", 9.5f))
        using (var b = new SolidBrush(Color.FromArgb(150, 160, 178)))
            g.DrawString(text, f, b, new RectangleF(50, 38, Width - 60, 32));
    }
}

/* ---------------- настройка рамок ---------------- */

class SetupForm : Form
{
    readonly Bitmap shot;
    readonly Settings s;
    readonly string key;
    RectangleF header, cards;
    int target; // 0 — шапка, 1 — карточки
    Point? dragFrom;
    Rectangle dragRect;
    readonly Panel canvas;
    readonly CheckBox cardsOn;
    readonly RadioButton rbHeader, rbCards;

    static readonly Color CHeader = Color.FromArgb(29, 158, 117), CCards = Color.FromArgb(127, 119, 221);

    public SetupForm(Bitmap shot, Settings s)
    {
        this.shot = shot; this.s = s;
        key = Settings.Key(shot.Size);
        Frames f;
        if (s.PerRes.TryGetValue(key, out f)) { header = f.Header; cards = f.Cards.IsEmpty ? Settings.DefCards : f.Cards; }
        else { header = Settings.DefHeader; cards = Settings.DefCards; }
        Text = "Рамки для экрана " + Settings.Key(shot.Size) + " — NC Exchange помощник";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        var wa = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(1280, wa.Width - 80), Math.Min(860, wa.Height - 60));
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(16, 20, 28);
        ForeColor = Color.FromArgb(230, 235, 245);
        Font = new Font("Segoe UI", 10f);
        KeyPreview = true;

        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 78, Padding = new Padding(12, 10, 12, 0), BackColor = BackColor };
        var hint = new Label
        {
            AutoSize = false, Width = 1200, Height = 26,
            Text = "Выбери рамку и обведи мышкой нужное место на снимке. Шапка — тикер, цена и %; карточки — показатели под графиком.",
            ForeColor = Color.FromArgb(160, 170, 188)
        };
        rbHeader = new RadioButton { Text = "Шапка: тикер и цена", AutoSize = true, Checked = true, ForeColor = CHeader, Margin = new Padding(0, 6, 18, 0) };
        rbCards = new RadioButton { Text = "Карточки показателей", AutoSize = true, ForeColor = CCards, Margin = new Padding(0, 6, 18, 0) };
        cardsOn = new CheckBox { Text = "Снимать карточки", AutoSize = true, Checked = s.CardsOn, Margin = new Padding(0, 6, 18, 0) };
        rbHeader.CheckedChanged += (o, e) => { target = rbHeader.Checked ? 0 : 1; };
        cardsOn.CheckedChanged += (o, e) => canvas.Invalidate();
        top.Controls.AddRange(new Control[] { hint, rbHeader, rbCards, cardsOn });
        top.SetFlowBreak(hint, true);

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(10, 8, 10, 8), BackColor = BackColor };
        var save = Btn("Сохранить", true);
        var cancel = Btn("Отмена", false);
        var reset = Btn("Как было по умолчанию", false);
        save.Click += (o, e) =>
        {
            s.PerRes[key] = new Frames { Header = header, Cards = cards, Manual = true };
            s.CardsOn = cardsOn.Checked; s.Save();
            DialogResult = DialogResult.OK; Close();
        };
        cancel.Click += (o, e) => Close();
        reset.Click += (o, e) => { header = Settings.DefHeader; cards = Settings.DefCards; canvas.Invalidate(); };
        bottom.Controls.AddRange(new Control[] { save, cancel, reset });
        AcceptButton = save; CancelButton = cancel;

        canvas = new DoubleBufferedPanel { Dock = DockStyle.Fill, BackColor = Color.Black, Cursor = Cursors.Cross };
        canvas.Paint += PaintCanvas;
        canvas.MouseDown += (o, e) => { if (e.Button == MouseButtons.Left) { dragFrom = e.Location; dragRect = Rectangle.Empty; } };
        canvas.MouseMove += (o, e) =>
        {
            if (dragFrom == null) return;
            var a = dragFrom.Value;
            dragRect = Rectangle.FromLTRB(Math.Min(a.X, e.X), Math.Min(a.Y, e.Y), Math.Max(a.X, e.X), Math.Max(a.Y, e.Y));
            canvas.Invalidate();
        };
        canvas.MouseUp += (o, e) =>
        {
            if (dragFrom == null) return;
            dragFrom = null;
            var img = ImageRect();
            if (dragRect.Width > 8 && dragRect.Height > 8 && img.Width > 0)
            {
                var r = new RectangleF((dragRect.X - img.X) / (float)img.Width, (dragRect.Y - img.Y) / (float)img.Height,
                    dragRect.Width / (float)img.Width, dragRect.Height / (float)img.Height);
                r.Intersect(new RectangleF(0, 0, 1, 1));
                if (target == 0) header = r; else { cards = r; cardsOn.Checked = true; }
            }
            dragRect = Rectangle.Empty;
            canvas.Invalidate();
        };
        Controls.Add(canvas);
        Controls.Add(top);
        Controls.Add(bottom);
    }

    static Button Btn(string text, bool primary)
    {
        return new Button
        {
            Text = text, AutoSize = true, Height = 34, FlatStyle = FlatStyle.Flat, Margin = new Padding(6, 0, 0, 0),
            BackColor = primary ? Color.FromArgb(52, 211, 153) : Color.FromArgb(30, 37, 50),
            ForeColor = primary ? Color.FromArgb(6, 40, 28) : Color.FromArgb(230, 235, 245),
            Padding = new Padding(10, 0, 10, 0)
        };
    }

    Rectangle ImageRect()
    {
        var c = canvas.ClientSize;
        if (shot.Width == 0 || c.Width == 0) return Rectangle.Empty;
        float k = Math.Min(c.Width / (float)shot.Width, c.Height / (float)shot.Height);
        int w = (int)(shot.Width * k), h = (int)(shot.Height * k);
        return new Rectangle((c.Width - w) / 2, (c.Height - h) / 2, w, h);
    }

    void PaintCanvas(object o, PaintEventArgs e)
    {
        var g = e.Graphics;
        var img = ImageRect();
        g.InterpolationMode = InterpolationMode.HighQualityBilinear;
        g.DrawImage(shot, img);
        using (var dim = new SolidBrush(Color.FromArgb(110, 0, 0, 0))) g.FillRectangle(dim, img);
        Frame(g, img, header, CHeader, "шапка");
        if (cardsOn.Checked) Frame(g, img, cards, CCards, "карточки");
        if (!dragRect.IsEmpty)
            using (var p = new Pen(target == 0 ? CHeader : CCards, 2) { DashStyle = DashStyle.Dash }) g.DrawRectangle(p, dragRect);
    }

    void Frame(Graphics g, Rectangle img, RectangleF f, Color c, string label)
    {
        var r = Rectangle.Round(new RectangleF(img.X + f.X * img.Width, img.Y + f.Y * img.Height, f.Width * img.Width, f.Height * img.Height));
        var src = Rectangle.Round(new RectangleF(f.X * shot.Width, f.Y * shot.Height, f.Width * shot.Width, f.Height * shot.Height));
        g.DrawImage(shot, r, src, GraphicsUnit.Pixel); // внутри рамки — без затемнения
        using (var p = new Pen(c, 2)) g.DrawRectangle(p, r);
        using (var f2 = new Font("Segoe UI Semibold", 9f))
        {
            var sz = g.MeasureString(label, f2);
            using (var b = new SolidBrush(c)) g.FillRectangle(b, r.X, r.Y - sz.Height - 2, sz.Width + 8, sz.Height + 2);
            g.DrawString(label, f2, Brushes.White, r.X + 4, r.Y - sz.Height - 1);
        }
    }

    class DoubleBufferedPanel : Panel
    {
        public DoubleBufferedPanel() { DoubleBuffered = true; ResizeRedraw = true; }
    }
}

/* ---------------- плашка состояния поверх игры ---------------- */

// Маленькая плашка сверху по центру окна игры: работает ли помощник и можно ли снимать.
// Не забирает фокус и пропускает клики в игру.
class Plaque : Form
{
    string text = "";
    Color dot = Color.Gray;

    public Plaque()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(18, 22, 31);
        Size = new Size(300, 28);
        Opacity = 0.9;
        DoubleBuffered = true;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08 | 0x20 | 0x80 | 0x80000 | 0x08000000; // поверх, сквозь клики, без панели задач, не активируется
            return cp;
        }
    }

    public void Set(string t, Color c, Rectangle game)
    {
        if (t != text || c != dot) { text = t; dot = c; Invalidate(); }
        using (var g = CreateGraphics())
        using (var f = new Font("Segoe UI Semibold", 9f))
            Width = (int)g.MeasureString(text, f).Width + 40;
        var p = new Point(game.Left + (game.Width - Width) / 2, game.Top + 8);
        if (Location != p) Location = p;
        if (!Visible) Show();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        using (var pen = new Pen(Color.FromArgb(48, 56, 72))) g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        using (var b = new SolidBrush(dot)) g.FillEllipse(b, 12, 9, 10, 10);
        using (var f = new Font("Segoe UI Semibold", 9f))
        using (var b = new SolidBrush(Color.FromArgb(225, 232, 244)))
            g.DrawString(text, f, b, 28, 5);
    }
}

/* ---------------- приложение в трее ---------------- */

class HelperApp : ApplicationContext
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    readonly Settings settings = Settings.Load();
    readonly Bridge bridge;
    readonly NotifyIcon tray;
    readonly Toast toast = new Toast();
    readonly Plaque plaque = new Plaque();
    readonly HotkeyWindow hk;
    readonly ToolStripMenuItem statusItem, snapItem, keyMenu, soundItem, plaqueItem, samplesItem;
    readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer { Interval = 250 };
    Bitmap lastFull;

    // снимки, по которым сайт ещё не ответил: id → (когда, разрешение, настройка рамок)
    class Sent { public DateTime At; public string Key; public bool Calib; }
    readonly Dictionary<string, Sent> sent = new Dictionary<string, Sent>();
    double avgSec = 4;

    // готовность к снимку: шапка не меняется и отличается от последней снятой
    byte[] prevSig, lastSnapSig;
    DateTime stableSince = DateTime.Now, lastSnapAt = DateTime.MinValue;
    bool stable;

    static readonly Keys[] KeyChoices = { Keys.F7, Keys.F9, Keys.F10, Keys.Insert, Keys.Home, Keys.Pause };
    static readonly Color Blue = Color.FromArgb(96, 165, 250), Green = Color.FromArgb(52, 211, 153),
        Yellow = Color.FromArgb(251, 191, 36), Red = Color.FromArgb(248, 113, 113), Gray = Color.FromArgb(120, 130, 148);

    public HelperApp()
    {
        toast.CreateControl();
        var h = toast.Handle; // окно уведомлений нужно создать в UI-потоке заранее — через него идут BeginInvoke
        bridge = new Bridge(settings);
        bridge.Result += r => toast.BeginInvoke((Action)(() => OnResult(r)));
        bridge.Sample += r => SaveSample(r);
        bridge.Start();

        var menu = new ContextMenuStrip();
        statusItem = new ToolStripMenuItem("…") { Enabled = false };
        snapItem = new ToolStripMenuItem("Снять биржу", null, (s, e) => Snap());
        keyMenu = new ToolStripMenuItem("Горячая клавиша");
        foreach (var k in KeyChoices)
        {
            var key = k;
            keyMenu.DropDownItems.Add(new ToolStripMenuItem(k.ToString(), null, (s, e) => SetKey(key)));
        }
        soundItem = new ToolStripMenuItem("Звук снимка", null, (s, e) => { settings.Sound = !settings.Sound; settings.Save(); RefreshMenu(); });
        plaqueItem = new ToolStripMenuItem("Плашка поверх игры", null, (s, e) => { settings.Plaque = !settings.Plaque; settings.Save(); RefreshMenu(); });
        samplesItem = new ToolStripMenuItem("Сохранять снимки для обучения", null, (s, e) => { settings.Samples = !settings.Samples; settings.Save(); RefreshMenu(); });
        menu.Items.AddRange(new ToolStripItem[] {
            statusItem, new ToolStripSeparator(), snapItem,
            new ToolStripMenuItem("Найти рамки заново (автоматически)", null, (s, e) => Recalibrate()),
            new ToolStripMenuItem("Настроить рамки вручную…", null, (s, e) => Setup()),
            keyMenu, soundItem, plaqueItem, samplesItem,
            new ToolStripMenuItem("Папка снимков для обучения", null, (s, e) => OpenSamples()),
            new ToolStripSeparator(),
            new ToolStripMenuItem("Открыть сайт биржи", null, (s, e) => OpenSite()),
            new ToolStripMenuItem("Выход", null, (s, e) => Quit()) });
        menu.Opening += (s, e) => RefreshMenu();

        tray = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
            Text = "NC Exchange помощник " + Program.Version,
            ContextMenuStrip = menu,
            Visible = true
        };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Setup(); };

        hk = new HotkeyWindow();
        hk.Pressed += Snap;
        if (!hk.Register(settings.Hotkey))
            toast.Pop("Клавиша " + settings.Hotkey + " занята", "Выбери другую: правый клик по значку в трее → Горячая клавиша", Yellow, 8000);

        tick.Tick += (s, e) => Tick();
        tick.Start();

        if (bridge.Error != null) toast.Pop("Помощник не запустился", bridge.Error, Red, 10000);
        else toast.Pop("Помощник " + Program.Version + " запущен", "Открой биржу в игре, выбери акцию и нажми " + settings.Hotkey, Blue, 6000);
        RefreshMenu();
    }

    Frames CurrentFrames(Size s)
    {
        Frames f;
        return settings.PerRes.TryGetValue(Settings.Key(s), out f) ? f : null;
    }

    // Каждые 250 мс: следим за шапкой (для «можно снимать») и обновляем плашку
    void Tick()
    {
        var now = DateTime.Now;
        foreach (var id in sent.Where(kv => (now - kv.Value.At).TotalSeconds > 90).Select(kv => kv.Key).ToList()) sent.Remove(id);

        var w = Game.Window();
        var game = Game.ClientOnScreen(w);
        var fg = GetForegroundWindow();
        bool inGame = !game.IsEmpty && (fg == w || fg == toast.Handle || fg == plaque.Handle);
        if (!settings.Plaque || !inGame) { if (plaque.Visible) plaque.Hide(); return; }

        var f = CurrentFrames(game.Size);
        bool same = false;
        if (f != null)
        {
            var r = Game.Part(game.Size, f.Header);
            r.Offset(game.Location);
            if (r.Width > 10 && r.Height > 10)
                using (var b = Game.Grab(r))
                {
                    var sig = Game.Signature(b);
                    if (Game.Diff(sig, prevSig) > 3) { stableSince = now; stable = false; }
                    else stable = (now - stableSince).TotalMilliseconds > 500;
                    prevSig = sig;
                    same = Game.Diff(sig, lastSnapSig) < 3;
                }
        }

        string text; Color c;
        int waiting = sent.Count + bridge.Pending;
        if (bridge.PortError) { text = "NCX · не запустился: порт занят"; c = Red; }
        else if (!bridge.SiteConnected) { text = "NCX · открой сайт биржи на этом ПК"; c = Yellow; }
        else if (sent.Values.Any(x => x.Calib)) { text = "NCX · настраиваю рамки под твой экран…"; c = Blue; }
        else if (waiting > 0) { text = "NCX · распознаю… (" + waiting + ") ~" + Math.Round(avgSec * waiting) + " с"; c = Blue; }
        else if (f == null) { text = "NCX · " + settings.Hotkey + " — первый снимок настроит рамки"; c = Green; }
        else if (!stable) { text = "NCX · экран меняется…"; c = Gray; }
        else if (same) { text = "NCX · эта акция уже снята"; c = Gray; }
        else { text = "NCX · можно снимать · " + settings.Hotkey; c = Green; }
        plaque.Set(text, c, game);
    }

    void RefreshMenu()
    {
        var game = Game.ClientOnScreen(Game.Window());
        var f = game.IsEmpty ? null : CurrentFrames(game.Size);
        statusItem.Text = (bridge.SiteConnected ? "● Сайт подключён" : "○ Сайт не открыт") + " · " +
            (game.IsEmpty ? "MTA не найдена" : "MTA " + Settings.Key(game.Size) + (f == null ? ", рамки ещё не найдены" : f.Manual ? ", рамки вручную" : ", рамки найдены"));
        snapItem.Text = "Снять биржу (" + settings.Hotkey + ")";
        soundItem.Checked = settings.Sound;
        plaqueItem.Checked = settings.Plaque;
        samplesItem.Checked = settings.Samples;
        foreach (ToolStripMenuItem i in keyMenu.DropDownItems) i.Checked = i.Text == settings.Hotkey.ToString();
    }

    void SetKey(Keys k)
    {
        hk.Unregister();
        if (hk.Register(k)) { settings.Hotkey = k; settings.Save(); toast.Pop("Клавиша снимка: " + k, "Нажимай её в игре, когда открыта акция на бирже", Blue, 4000); }
        else { hk.Register(settings.Hotkey); toast.Pop("Клавиша " + k + " занята", "Её уже использует другая программа", Yellow, 5000); }
        RefreshMenu();
    }

    Bitmap GrabGame(out string error, bool needFront = true)
    {
        error = null;
        var w = Game.Window();
        if (w == IntPtr.Zero) { error = "MTA не найдена — запусти игру"; return null; }
        // снимаем область экрана: если поверх игры другое окно, на снимке будет оно
        if (needFront && GetForegroundWindow() != w) { error = "Сначала переключись в окно игры"; return null; }
        var r = Game.ClientOnScreen(w);
        if (r.Width < 200 || r.Height < 200) { error = "Окно игры свёрнуто"; return null; }
        var b = Game.Grab(r);
        if (Game.IsBlack(b))
        {
            b.Dispose();
            error = "Снимок чёрный: в настройках MTA включи режим «Оконный без рамки»";
            return null;
        }
        return b;
    }

    // Подождать (до 1,5 с), пока шапка перестанет меняться: после выбора акции в планшете
    // цена и график дорисовываются не сразу
    void WaitStable(Frames f)
    {
        if (f == null) return;
        var game = Game.ClientOnScreen(Game.Window());
        var r = Game.Part(game.Size, f.Header);
        r.Offset(game.Location);
        if (r.Width < 10 || r.Height < 10) return;
        byte[] prev = null;
        var until = DateTime.Now.AddMilliseconds(1500);
        int calm = 0;
        while (DateTime.Now < until && calm < 3)
        {
            using (var b = Game.Grab(r))
            {
                var sig = Game.Signature(b);
                calm = Game.Diff(sig, prev) < 3 ? calm + 1 : 0;
                prev = sig;
            }
            Thread.Sleep(100);
        }
    }

    void Snap()
    {
        var game = Game.ClientOnScreen(Game.Window());
        var f = game.IsEmpty ? null : CurrentFrames(game.Size);
        WaitStable(f);
        string err;
        var full = GrabGame(out err);
        if (full == null) { toast.Pop("Снимок не сделан", err, Red, 6000); return; }

        var key = Settings.Key(full.Size);
        var images = new List<object>();
        byte[] sig = null;
        if (f != null)
        {
            var hr = Game.Part(full.Size, f.Header);
            if (hr.Width > 10 && hr.Height > 10)
            {
                images.Add(new Dictionary<string, object> { { "name", "header" }, { "data", Game.Png64(full, hr) } });
                using (var hb = full.Clone(hr, full.PixelFormat)) sig = Game.Signature(hb);
            }
            if (settings.CardsOn && !f.Cards.IsEmpty)
            {
                var cr = Game.Part(full.Size, f.Cards);
                if (cr.Width > 10 && cr.Height > 10) images.Add(new Dictionary<string, object> { { "name", "cards" }, { "data", Game.Png64(full, cr) } });
            }
            // та же акция второй раз подряд — скорее случайное нажатие; повторное нажатие в
            // течение 3 с всё-таки снимает
            if (sig != null && Game.Diff(sig, lastSnapSig) < 3 && (DateTime.Now - lastSnapAt).TotalSeconds > 3)
            {
                lastSnapAt = DateTime.Now;
                toast.Pop("Эта акция уже снята", "Открой другую. Нужен ещё раз — нажми " + settings.Hotkey + " снова", Gray, 4000);
                full.Dispose();
                return;
            }
        }
        // рамок для этого экрана нет — отправляем весь экран, сайт сам найдёт шапку и карточки
        bool calib = images.Count == 0;
        if (calib) images.Add(new Dictionary<string, object> { { "name", "full" }, { "data", Game.Png64(full) } });

        if (settings.Sound) Shutter.Play();
        if (lastFull != null) lastFull.Dispose();
        lastFull = full;
        lastSnapSig = sig;
        lastSnapAt = DateTime.Now;

        var id = DateTime.Now.Ticks.ToString("x");
        sent[id] = new Sent { At = DateTime.Now, Key = key, Calib = calib };
        bridge.Push(new Dictionary<string, object> {
            { "id", id }, { "at", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds },
            { "width", full.Width }, { "height", full.Height }, { "calibrate", calib }, { "images", images } });

        if (!bridge.SiteConnected)
            toast.Pop("Снимок сохранён", "Сайт биржи не открыт — открой его, и цены отправятся (в очереди: " + bridge.Pending + ")", Yellow, 7000);
        else if (calib)
            toast.Pop("Первый снимок на этом экране", "Сайт ищет шапку и карточки — около 10 секунд, дальше быстрее", Blue, 30000);
        else
            toast.Pop("Снимок сделан", "Распознаю на сайте…", Blue, 30000);
    }

    static float F(object o) { return Convert.ToSingle(o, CultureInfo.InvariantCulture); }

    static RectangleF Rect(object o)
    {
        var a = o as System.Collections.IList;
        if (a == null || a.Count != 4) return RectangleF.Empty;
        return new RectangleF(F(a[0]), F(a[1]), F(a[2]), F(a[3]));
    }

    void OnResult(Dictionary<string, object> r)
    {
        object v;
        string id = r.TryGetValue("id", out v) ? v as string : null;
        string status = r.TryGetValue("status", out v) ? v as string : "";
        string title = r.TryGetValue("title", out v) ? v as string : "";
        string text = r.TryGetValue("text", out v) ? v as string : "";
        Sent s = null;
        if (id != null && sent.TryGetValue(id, out s))
        {
            sent.Remove(id);
            avgSec = avgSec * 0.7 + (DateTime.Now - s.At).TotalSeconds * 0.3;
        }
        // сайт нашёл рамки на снимке всего экрана — запоминаем для этого разрешения
        if (s != null && r.TryGetValue("frames", out v) && v is Dictionary<string, object>)
        {
            var fr = (Dictionary<string, object>)v;
            object hv, cv;
            var hdr = fr.TryGetValue("header", out hv) ? Rect(hv) : RectangleF.Empty;
            var crd = fr.TryGetValue("cards", out cv) ? Rect(cv) : RectangleF.Empty;
            if (!hdr.IsEmpty)
            {
                settings.PerRes[s.Key] = new Frames { Header = hdr, Cards = crd };
                settings.Save();
                text = (text ?? "") + " · рамки для " + s.Key + " найдены";
            }
        }
        // по рамкам ничего не нашлось — экран или масштаб интерфейса изменились, следующий
        // снимок снова будет целым экраном (рамки, поставленные вручную, не трогаем)
        if (s != null && r.TryGetValue("recalibrate", out v) && v is bool && (bool)v)
        {
            Frames f;
            if (settings.PerRes.TryGetValue(s.Key, out f) && !f.Manual) { settings.PerRes.Remove(s.Key); settings.Save(); }
        }
        // страница сайта открыта ещё со старой версии: снимок экрана целиком она проверяет как
        // обычный скриншот и рамок не возвращает — без этого каждый снимок был бы целым экраном
        if (s != null && s.Calib && status != "error" && !r.ContainsKey("frames"))
        {
            toast.Pop("Обнови страницу сайта биржи", "Открыта старая версия сайта — нажми на ней Ctrl+F5, тогда снимки будут только нужных мест", Yellow, 12000);
            return;
        }
        var c = status == "ok" ? Green : status == "check" ? Yellow : Red;
        toast.Pop(title ?? "", text ?? "", c, status == "ok" ? 4500 : 8000);
    }

    // Проверенный снимок с правильными значениями — для дообучения распознавания цифр
    void SaveSample(Dictionary<string, object> r)
    {
        if (!settings.Samples) return;
        try
        {
            object id, img, truth;
            if (!r.TryGetValue("id", out id) || !r.TryGetValue("image", out img) || !r.TryGetValue("truth", out truth)) return;
            var dir = Path.Combine(Settings.Dir, "samples");
            Directory.CreateDirectory(dir);
            var name = new string(id.ToString().Where(char.IsLetterOrDigit).ToArray());
            if (name.Length == 0) return;
            File.WriteAllBytes(Path.Combine(dir, name + ".png"), Convert.FromBase64String(img.ToString()));
            File.WriteAllText(Path.Combine(dir, name + ".json"), new JavaScriptSerializer().Serialize(truth), Encoding.UTF8);
        }
        catch { }
    }

    void Recalibrate()
    {
        var game = Game.ClientOnScreen(Game.Window());
        if (game.IsEmpty) { toast.Pop("MTA не найдена", "Запусти игру — рамки ищутся по её окну", Yellow, 5000); return; }
        settings.PerRes.Remove(Settings.Key(game.Size));
        settings.Save();
        toast.Pop("Рамки сброшены", "Открой акцию на бирже и нажми " + settings.Hotkey + " — сайт найдёт их заново", Blue, 6000);
    }

    void Setup()
    {
        Bitmap shot = lastFull;
        string err = null;
        var game = Game.ClientOnScreen(Game.Window());
        // последний снимок с другого разрешения не подходит — снимаем заново
        if (shot != null && !game.IsEmpty && shot.Size != game.Size) shot = null;
        if (shot == null) shot = GrabGame(out err, false);
        if (shot == null)
        {
            MessageBox.Show("Сначала открой биржу в игре, выбери любую акцию и нажми " + settings.Hotkey +
                " — рамки настраиваются по этому снимку.\n\n" + err, "Настройка рамок");
            return;
        }
        if (lastFull != null && lastFull != shot) lastFull.Dispose();
        lastFull = shot;
        using (var f = new SetupForm(shot, settings))
            if (f.ShowDialog() == DialogResult.OK) toast.Pop("Рамки сохранены", "Для экрана " + Settings.Key(shot.Size), Green, 3500);
    }

    static void OpenSite() { try { Process.Start(Program.Site); } catch { } }

    static void OpenSamples()
    {
        var dir = Path.Combine(Settings.Dir, "samples");
        try { Directory.CreateDirectory(dir); Process.Start(dir); } catch { }
    }

    void Quit()
    {
        hk.Unregister();
        tray.Visible = false;
        ExitThread();
        Environment.Exit(0);
    }
}

class HotkeyWindow : NativeWindow
{
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    public event Action Pressed;

    public HotkeyWindow() { CreateHandle(new CreateParams()); }

    public bool Register(Keys k) { return RegisterHotKey(Handle, 1, 0x4000 /* без автоповтора */, (uint)k); }
    public void Unregister() { UnregisterHotKey(Handle, 1); }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312 && Pressed != null) Pressed();
        base.WndProc(ref m);
    }
}

// Тихий мягкий двойной сигнал вместо щелчка затвора — синтезируем, чтобы не таскать звуковой файл
static class Shutter
{
    static byte[] wav;

    public static void Play()
    {
        try
        {
            if (wav == null) wav = Make();
            new SoundPlayer(new MemoryStream(wav)).Play();
        }
        catch { }
    }

    static byte[] Make()
    {
        const int rate = 22050;
        int n = rate * 260 / 1000;
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + n * 2); w.Write(Encoding.ASCII.GetBytes("WAVE"));
        w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16); w.Write((short)1); w.Write((short)1);
        w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write(Encoding.ASCII.GetBytes("data")); w.Write(n * 2);
        for (int i = 0; i < n; i++)
        {
            double t = i / (double)rate;
            // две чистые ноты (ми и ля второй октавы) с плавным началом и затуханием
            double v = Note(t, 0, 659.3, 0.10) + Note(t, 0.07, 880.0, 0.19);
            w.Write((short)(v * 2600));
        }
        return ms.ToArray();
    }

    static double Note(double t, double start, double freq, double len)
    {
        double x = t - start;
        if (x < 0 || x > len) return 0;
        double env = Math.Min(1, x / 0.012) * Math.Exp(-x * 5 / len) * Math.Min(1, (len - x) / 0.02);
        return Math.Sin(2 * Math.PI * freq * x) * env;
    }
}
