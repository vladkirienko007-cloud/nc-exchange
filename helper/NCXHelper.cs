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
[assembly: System.Reflection.AssemblyVersion("1.5.4.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.5.4.0")]

static class Program
{
    public const string Version = "1.5.4";
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
    public Keys Hotkey = Keys.F5;
    public bool On = true;                       // кнопка включения на панели
    public Point PanelAt = new Point(-1, -1);    // центр верхнего края панели относительно окна игры (-1 — сверху по центру)
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
                else if (k == "key") { Keys key; if (Enum.TryParse(v, out key)) s.Hotkey = key; }
                else if (k == "on") s.On = v != "0";
                else if (k == "panelc")
                {
                    var xy = v.Split(',');
                    int x, y;
                    if (xy.Length == 2 && int.TryParse(xy[0], out x) && int.TryParse(xy[1], out y)) s.PanelAt = new Point(x, y);
                }
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
                "samples=" + (Samples ? 1 : 0), "key=" + Hotkey, "on=" + (On ? 1 : 0), "panelc=" + PanelAt.X + "," + PanelAt.Y };
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
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);

    // Окна помощника не попадают на снимки (Windows 10 2004+), даже если панель
    // перетащили на шапку или карточки
    public static bool HideFromCapture(IntPtr h)
    {
        try { return SetWindowDisplayAffinity(h, 0x11 /* WDA_EXCLUDEFROMCAPTURE */); } catch { return false; }
    }

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
        BackColor = Color.FromArgb(14, 14, 16);
        ForeColor = Color.FromArgb(242, 242, 243);
        Font = new Font("Segoe UI", 10f);
        KeyPreview = true;

        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 78, Padding = new Padding(12, 10, 12, 0), BackColor = BackColor };
        var hint = new Label
        {
            AutoSize = false, Width = 1200, Height = 26,
            Text = "Выбери рамку и обведи мышкой нужное место на снимке. Шапка — тикер, цена и %; карточки — показатели под графиком.",
            ForeColor = Color.FromArgb(161, 161, 170)
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
            BackColor = primary ? Color.FromArgb(242, 242, 243) : Color.FromArgb(34, 34, 38),
            ForeColor = primary ? Color.FromArgb(17, 17, 17) : Color.FromArgb(242, 242, 243),
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

// Панель «Остров» поверх окна игры — всё в одном: состояние помощника, клавиша снимка,
// кнопки «снять» и «вкл/выкл», а после снимка на несколько секунд его итог прямо в строке.
// Перетаскивается за любое место кроме кнопок, место запоминается. Не забирает фокус у игры.
// Окно непрозрачное и обрезано по форме капсулы: только такое Windows 10 позволяет спрятать
// от снимков и записи экрана (полупрозрачное — нет). Гладкие края — подмешиваем к ним то,
// что под панелью: её саму захват экрана не видит.
class Plaque : Form
{
    // размеры в пикселях — одинаково при любом масштабе Windows
    const int M = 1;           // запас под сглаженный край
    const int H = 32;          // высота капсулы
    const int Btn = 24;        // круглые кнопки
    const int Gap = 8;
    const int MaxNote = 600;   // самая широкая строка итога

    static readonly Font StatusFont = new Font("Segoe UI", 13f, GraphicsUnit.Pixel);
    static readonly Font StrongFont = new Font("Segoe UI Semibold", 13f, GraphicsUnit.Pixel);
    static readonly Font KeyFont = new Font("Segoe UI Semibold", 11f, GraphicsUnit.Pixel);
    static readonly StringFormat Fmt = MakeFmt();
    static readonly Color Bg = Color.FromArgb(246, 23, 23, 26), Edge = Color.FromArgb(26, 255, 255, 255),
        Ink = Color.FromArgb(242, 242, 243), Muted = Color.FromArgb(139, 139, 147), Ghost = Color.FromArgb(16, 255, 255, 255),
        GhostHi = Color.FromArgb(34, 255, 255, 255), ChipBg = Color.FromArgb(30, 255, 255, 255), PowerOn = Color.FromArgb(52, 211, 153);

    string text = "", key = "";
    Color dot = Color.Gray;
    bool on = true;
    Rectangle game;
    Point at = new Point(-1, -1);       // центр верхнего края капсулы относительно окна игры
    bool dragging, moved;
    Point grab;
    int hover = -1;                     // 0 — снять, 1 — вкл/выкл
    int pillW;
    RectangleF chip;
    Rectangle snapBtn, powerBtn;
    bool hidden;                        // окно спрятано от снимков экрана
    Bitmap backdrop;                    // что под панелью — для сглаженных краёв

    // итог снимка: заменяет строку состояния на несколько секунд
    string noteTitle, noteText;
    Color noteColor;
    readonly System.Windows.Forms.Timer noteTimer = new System.Windows.Forms.Timer();

    public event Action SnapClicked, PowerClicked, MenuRequested;
    public event Action<Point> Moved;

    public Plaque()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(200 + M * 2, H + M * 2);
        BackColor = Color.FromArgb(23, 23, 26);
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        noteTimer.Tick += (s, e) => HideNote();
    }

    static StringFormat MakeFmt()
    {
        var f = (StringFormat)StringFormat.GenericTypographic.Clone();
        f.FormatFlags |= StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces;
        f.Trimming = StringTrimming.EllipsisCharacter;
        f.LineAlignment = StringAlignment.Center;
        return f;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // поверх, без панели задач, не активируется (игра остаётся в фокусе)
            cp.ExStyle |= 0x08 | 0x80 | 0x08000000;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); hidden = Game.HideFromCapture(Handle); }

    // клик по окну без активации: игра не теряет фокус, иначе снимок не сделать
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x21 /* WM_MOUSEACTIVATE */) { m.Result = (IntPtr)3 /* MA_NOACTIVATE */; return; }
        base.WndProc(ref m);
    }

    public bool HasNote { get { return noteTitle != null; } }

    // На время скриншота панель прячется: не все программы снимков слушаются защиты окна
    DateTime suppressUntil = DateTime.MinValue;
    public void Suppress(int ms)
    {
        suppressUntil = DateTime.Now.AddMilliseconds(ms);
        if (Visible) Hide();
    }

    public void Notify(string t, string s, Color c, int ms)
    {
        noteTitle = t ?? ""; noteText = s ?? ""; noteColor = c;
        // подпись идёт в той же строке после заголовка — со строчной буквы
        if (noteText.Length > 1 && char.IsUpper(noteText[0]) && !char.IsUpper(noteText[1])) noteText = char.ToLower(noteText[0]) + noteText.Substring(1);
        noteTimer.Stop();
        noteTimer.Interval = ms;
        noteTimer.Start();
        Relayout();
    }

    public void HideNote()
    {
        noteTimer.Stop();
        if (noteTitle == null) return;
        noteTitle = noteText = null;
        Relayout();
    }

    public void Set(string t, Color c, Rectangle g, string k, bool isOn, Point rel)
    {
        bool changed = t != text || c != dot || k != key || isOn != on || g != game;
        text = t; dot = c; key = k; on = isOn; game = g;
        if (!dragging) at = rel;
        if (DateTime.Now < suppressUntil) return;
        if (changed) Relayout();
        else Place();
        if (!Visible) Show();
        RefreshBackdrop(); // зовётся каждые 250 мс — края успевают за картинкой игры
    }

    static float Measure(Graphics g, string s, Font f) { return string.IsNullOrEmpty(s) ? 0 : g.MeasureString(s, f, 10000, Fmt).Width; }

    // ширина капсулы: [точка/значок] [текст] [клавиша] [камера] [питание]
    void Relayout()
    {
        int x = 14 + 8 + Gap + 2; // отступ, точка, зазор
        using (var bmp = new Bitmap(1, 1))
        using (var g = Graphics.FromImage(bmp))
        {
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            if (HasNote)
            {
                x = 6 + 20 + Gap;    // значок итога крупнее точки
                float tw = Measure(g, noteTitle, StrongFont) + (noteText.Length > 0 ? 10 + Measure(g, noteText, StatusFont) : 0);
                x += (int)Math.Ceiling(Math.Min(tw, MaxNote));
            }
            else
            {
                x += (int)Math.Ceiling(Measure(g, text, StatusFont));
                float kw = Measure(g, key, KeyFont) + 12;
                chip = new RectangleF(M + x + Gap, M + (H - 18) / 2f, kw, 18);
                x += Gap + (int)Math.Ceiling(kw);
            }
        }
        snapBtn = new Rectangle(M + x + Gap, M + (H - Btn) / 2, Btn, Btn);
        powerBtn = new Rectangle(snapBtn.Right + 4, snapBtn.Top, Btn, Btn);
        pillW = powerBtn.Right + 4 - M;
        var size = new Size(pillW + M * 2, H + M * 2);
        if (Size != size)
        {
            Size = size;
            using (var path = Pill(new RectangleF(M - 0.5f, M - 0.5f, pillW + 1, H + 1))) Region = new Region(path);
        }
        Place();
        RefreshBackdrop();
        Redraw();
    }

    void Place()
    {
        if (dragging || game.IsEmpty) return;
        // от центра: при смене ширины капсула раздвигается в обе стороны поровну
        int cx = at.X < 0 ? game.Width / 2 : at.X, top = at.X < 0 ? 8 : at.Y;
        var p = new Point(game.Left + cx - pillW / 2 - M, game.Top + top - M);
        p = Clamp(p);
        if (Location != p) Location = p;
    }

    Point Clamp(Point p)
    {
        if (game.IsEmpty) return p;
        return new Point(Math.Max(game.Left - M, Math.Min(p.X, game.Right - pillW - M)), Math.Max(game.Top - M, Math.Min(p.Y, game.Bottom - H - M)));
    }

    int Hit(Point p) { return snapBtn.Contains(p) ? 0 : powerBtn.Contains(p) ? 1 : -1; }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Right) { if (MenuRequested != null) MenuRequested(); return; }
        if (e.Button != MouseButtons.Left || Hit(e.Location) >= 0) return;
        dragging = true; moved = false;
        grab = e.Location;
        Capture = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (dragging)
        {
            var p = Clamp(new Point(Cursor.Position.X - grab.X, Cursor.Position.Y - grab.Y));
            if (p != Location) { Location = p; moved = true; RefreshBackdrop(); }
            return;
        }
        int h = Hit(e.Location);
        if (h != hover) { hover = h; Redraw(); }
        Cursor = h >= 0 ? Cursors.Hand : Cursors.SizeAll;
    }

    protected override void OnMouseLeave(EventArgs e) { if (hover != -1) { hover = -1; Redraw(); } }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (dragging)
        {
            dragging = false;
            Capture = false;
            if (moved && !game.IsEmpty)
            {
                at = new Point(Left + M + pillW / 2 - game.Left, Top + M - game.Top);
                if (Moved != null) Moved(at);
            }
            else if (!moved && HasNote) HideNote(); // щелчок по итогу — убрать его
            return;
        }
        if (e.Button != MouseButtons.Left) return;
        int h = Hit(e.Location);
        if (h == 0 && on && SnapClicked != null) SnapClicked();
        if (h == 1 && PowerClicked != null) PowerClicked();
    }

    // двойной щелчок — панель обратно сверху по центру
    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        if (Hit(e.Location) >= 0) return;
        at = new Point(-1, -1);
        if (Moved != null) Moved(at);
    }

    void Redraw() { if (pillW > 0) Invalidate(); }

    // Снять то, что под панелью (саму панель захват не видит). Если спрятать окно от снимков
    // не вышло, на снимке была бы сама панель — тогда края просто на тёмном фоне.
    public void RefreshBackdrop()
    {
        if (!hidden || !Visible || pillW <= 0) return;
        try
        {
            var b = new Bitmap(Width, Height, PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(b)) g.CopyFromScreen(Location, Point.Empty, Size);
            if (backdrop != null) backdrop.Dispose();
            backdrop = b;
            Invalidate();
        }
        catch { }
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (pillW <= 0) return;
        if (backdrop != null && backdrop.Size == Size) e.Graphics.DrawImageUnscaled(backdrop, 0, 0);
        else e.Graphics.Clear(BackColor);
        using (var bmp = Render()) e.Graphics.DrawImageUnscaled(bmp, 0, 0);
    }

    public Bitmap Render()
    {
        var bmp = new Bitmap(pillW + M * 2, H + M * 2, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            g.Clear(Color.Transparent);
            var pill = new RectangleF(M, M, pillW, H);

            using (var p = Pill(pill))
            {
                using (var b = new SolidBrush(Bg)) g.FillPath(b, p);
            }
            using (var p = Pill(new RectangleF(pill.X + 0.5f, pill.Y + 0.5f, pill.Width - 1, pill.Height - 1)))
            using (var pen = new Pen(Edge, 1f)) g.DrawPath(pen, p);

            float cy = M + H / 2f;
            if (HasNote)
            {
                // значок итога: ✓ сохранено, ! проверить, × ошибка, • прочее
                var ic = new RectangleF(M + 6, cy - 10, 20, 20);
                using (var b = new SolidBrush(Color.FromArgb(42, noteColor))) g.FillEllipse(b, ic);
                Glyph(g, ic, noteColor);
                float x = ic.Right + Gap, right = snapBtn.Left - Gap;
                float tw = Math.Min(g.MeasureString(noteTitle, StrongFont, 10000, Fmt).Width, right - x);
                using (var b = new SolidBrush(Ink)) g.DrawString(noteTitle, StrongFont, b, new RectangleF(x, M, tw + 1, H), Fmt);
                if (noteText.Length > 0 && right - (x + tw + 10) > 30)
                    using (var b = new SolidBrush(Muted)) g.DrawString(noteText, StatusFont, b, new RectangleF(x + tw + 10, M, right - (x + tw + 10), H), Fmt);
            }
            else
            {
                // точка состояния с мягким ореолом
                float dx = M + 14 + 4;
                using (var b = new SolidBrush(Color.FromArgb(48, dot))) g.FillEllipse(b, dx - 8, cy - 8, 16, 16);
                using (var b = new SolidBrush(dot)) g.FillEllipse(b, dx - 4, cy - 4, 8, 8);
                float x = M + 14 + 8 + Gap + 2;
                using (var b = new SolidBrush(on ? Ink : Muted))
                    g.DrawString(text, StatusFont, b, new RectangleF(x, M, chip.Left - Gap - x + 2, H), Fmt);
                // клавиша снимка — «кнопкой клавиатуры»
                using (var p = Round(chip, 5))
                using (var b = new SolidBrush(ChipBg)) g.FillPath(b, p);
                using (var b = new SolidBrush(on ? Ink : Muted))
                using (var f = (StringFormat)Fmt.Clone())
                {
                    f.Alignment = StringAlignment.Center;
                    g.DrawString(key, KeyFont, b, chip, f);
                }
            }

            // камера
            using (var b = new SolidBrush(hover == 0 && on ? GhostHi : Ghost)) g.FillEllipse(b, snapBtn);
            Camera(g, snapBtn, on ? Ink : Muted);
            // питание
            using (var b = new SolidBrush(hover == 1 ? GhostHi : Ghost)) g.FillEllipse(b, powerBtn);
            float px = powerBtn.Left + Btn / 2f, py = powerBtn.Top + Btn / 2f + 0.5f;
            using (var pen = new Pen(on ? PowerOn : Muted, 1.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                g.DrawArc(pen, px - 5.5f, py - 5.5f, 11, 11, -55, 290);
                g.DrawLine(pen, px, py - 7.5f, px, py - 1.5f);
            }
        }
        return bmp;
    }

    void Glyph(Graphics g, RectangleF r, Color c)
    {
        float cx = r.Left + r.Width / 2, cy = r.Top + r.Height / 2;
        using (var pen = new Pen(c, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
        {
            if (c.G > 180 && c.R < 120) g.DrawLines(pen, new[] { new PointF(cx - 4, cy + 0.5f), new PointF(cx - 1, cy + 3.5f), new PointF(cx + 4.5f, cy - 3) });
            else if (c.R > 240 && c.G > 150) { g.DrawLine(pen, cx, cy - 4.5f, cx, cy + 1); using (var b = new SolidBrush(c)) g.FillEllipse(b, cx - 1.2f, cy + 3, 2.4f, 2.4f); }
            else if (c.R > 240) { g.DrawLine(pen, cx - 3.5f, cy - 3.5f, cx + 3.5f, cy + 3.5f); g.DrawLine(pen, cx + 3.5f, cy - 3.5f, cx - 3.5f, cy + 3.5f); }
            else using (var b = new SolidBrush(c)) g.FillEllipse(b, cx - 2.5f, cy - 2.5f, 5, 5);
        }
    }

    static void Camera(Graphics g, Rectangle r, Color c)
    {
        float cx = r.Left + r.Width / 2f, cy = r.Top + r.Height / 2f + 0.5f;
        using (var pen = new Pen(c, 1.4f) { LineJoin = LineJoin.Round })
        {
            using (var body = Round(new RectangleF(cx - 6.5f, cy - 4.5f, 13, 9), 2.5f)) g.DrawPath(pen, body);
            g.DrawEllipse(pen, cx - 2.3f, cy - 2.3f, 4.6f, 4.6f);
            g.DrawLine(pen, cx - 2.5f, cy - 6.3f, cx + 2.5f, cy - 6.3f);
        }
    }

    static GraphicsPath Pill(RectangleF r) { return Round(r, r.Height / 2); }

    static GraphicsPath Round(RectangleF r, float rad)
    {
        float d = Math.Min(rad * 2, Math.Min(r.Width, r.Height));
        var path = new GraphicsPath();
        path.AddArc(r.Left, r.Top, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

/* ---------------- приложение в трее ---------------- */

class HelperApp : ApplicationContext
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    readonly Settings settings = Settings.Load();
    readonly Bridge bridge;
    readonly NotifyIcon tray;
    readonly Plaque plaque = new Plaque();
    readonly HotkeyWindow hk;
    readonly ScreenshotGuard guard;
    readonly ToolStripMenuItem statusItem, onItem, snapItem, keyMenu, soundItem, plaqueItem, samplesItem;
    readonly ContextMenuStrip menu;
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

    static readonly Keys[] KeyChoices = { Keys.F5, Keys.F6, Keys.F7, Keys.F9, Keys.F10, Keys.Insert, Keys.Home, Keys.Pause };
    bool keyBusyShown;
    static readonly Color Blue = Color.FromArgb(96, 165, 250), Green = Color.FromArgb(52, 211, 153),
        Yellow = Color.FromArgb(251, 191, 36), Red = Color.FromArgb(248, 113, 113), Gray = Color.FromArgb(139, 139, 147);

    public HelperApp()
    {
        plaque.CreateControl();
        var h = plaque.Handle; // окно панели нужно создать в UI-потоке заранее — через него идут BeginInvoke
        bridge = new Bridge(settings);
        bridge.Result += r => plaque.BeginInvoke((Action)(() => OnResult(r)));
        bridge.Sample += r => SaveSample(r);
        bridge.Start();

        menu = new ContextMenuStrip();
        statusItem = new ToolStripMenuItem("…") { Enabled = false };
        onItem = new ToolStripMenuItem("Включён", null, (s, e) => TogglePower());
        snapItem = new ToolStripMenuItem("Снять биржу", null, (s, e) => Snap());
        keyMenu = new ToolStripMenuItem("Горячая клавиша");
        foreach (var k in KeyChoices)
        {
            var key = k;
            keyMenu.DropDownItems.Add(new ToolStripMenuItem(k.ToString(), null, (s, e) => SetKey(key)));
        }
        soundItem = new ToolStripMenuItem("Звук снимка", null, (s, e) => { settings.Sound = !settings.Sound; settings.Save(); RefreshMenu(); });
        plaqueItem = new ToolStripMenuItem("Панель поверх игры", null, (s, e) => { settings.Plaque = !settings.Plaque; settings.Save(); RefreshMenu(); });
        samplesItem = new ToolStripMenuItem("Сохранять снимки для обучения", null, (s, e) => { settings.Samples = !settings.Samples; settings.Save(); RefreshMenu(); });
        menu.Items.AddRange(new ToolStripItem[] {
            statusItem, new ToolStripSeparator(), onItem, snapItem,
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

        // клавиша занята помощником, только пока открыта игра: F5 в браузере и других
        // программах работает как обычно
        guard = new ScreenshotGuard(ms => plaque.Suppress(ms));
        hk = new HotkeyWindow();
        hk.Pressed += Snap;

        plaque.SnapClicked += Snap;
        plaque.PowerClicked += TogglePower;
        plaque.MenuRequested += () => menu.Show(Cursor.Position);
        plaque.Moved += pt => { settings.PanelAt = pt; settings.Save(); };

        tick.Tick += (s, e) => Tick();
        tick.Start();

        if (bridge.Error != null) Pop("Помощник не запустился", bridge.Error, Red, 10000);
        else Pop("Помощник " + Program.Version + " запущен", "в игре открой акцию на бирже и жми " + settings.Hotkey, Blue, 6000);
        RefreshMenu();
    }

    // Итог снимка и прочие сообщения — в панели. Если игра не на экране, панель на время
    // сообщения появляется сверху по центру (окна игры или экрана) и потом снова прячется
    void Pop(string t, string s, Color c, int ms)
    {
        plaque.Notify(t, s, c, ms);
        if (plaque.Visible) return;
        var game = Game.ClientOnScreen(Game.Window());
        bool hasGame = !game.IsEmpty;
        plaque.Set("готово", Green, hasGame ? game : Screen.PrimaryScreen.WorkingArea, settings.Hotkey.ToString(), settings.On,
            hasGame ? settings.PanelAt : new Point(-1, -1));
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
        bool inGame = !game.IsEmpty && (fg == w || fg == plaque.Handle);
        bool wantKey = inGame && settings.On;
        if (wantKey != hk.Registered)
        {
            if (!wantKey) hk.Unregister();
            else if (!hk.Register(settings.Hotkey) && !keyBusyShown)
            {
                keyBusyShown = true;
                Pop("Клавиша " + settings.Hotkey + " занята", "снимай кнопкой-камерой или смени клавишу: правый клик", Yellow, 9000);
            }
        }
        // вне игры панель видна, только пока показывает сообщение
        if (!settings.Plaque || !inGame) { if (plaque.Visible && !plaque.HasNote) plaque.Hide(); return; }
        if (!settings.On) { plaque.Set("выключен", Gray, game, settings.Hotkey.ToString(), false, settings.PanelAt); return; }

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
        if (bridge.PortError) { text = "порт занят"; c = Red; }
        else if (!bridge.SiteConnected) { text = "открой сайт биржи"; c = Yellow; }
        else if (sent.Values.Any(x => x.Calib)) { text = "настраиваю рамки…"; c = Blue; }
        else if (waiting > 0) { text = (waiting > 1 ? "распознаю " + waiting + " · ~" : "распознаю · ~") + Math.Round(avgSec * waiting) + " с"; c = Blue; }
        else if (f == null) { text = "готово"; c = Green; }
        else if (!stable) { text = "экран меняется…"; c = Gray; }
        else if (same) { text = "уже снята"; c = Gray; }
        else { text = "готово"; c = Green; }
        plaque.Set(text, c, game, settings.Hotkey.ToString(), true, settings.PanelAt);
    }

    void RefreshMenu()
    {
        var game = Game.ClientOnScreen(Game.Window());
        var f = game.IsEmpty ? null : CurrentFrames(game.Size);
        statusItem.Text = (bridge.SiteConnected ? "● Сайт подключён" : "○ Сайт не открыт") + " · " +
            (game.IsEmpty ? "MTA не найдена" : "MTA " + Settings.Key(game.Size) + (f == null ? ", рамки ещё не найдены" : f.Manual ? ", рамки вручную" : ", рамки найдены"));
        snapItem.Text = "Снять биржу (" + settings.Hotkey + ")";
        snapItem.Enabled = settings.On;
        onItem.Checked = settings.On;
        soundItem.Checked = settings.Sound;
        plaqueItem.Checked = settings.Plaque;
        samplesItem.Checked = settings.Samples;
        foreach (ToolStripMenuItem i in keyMenu.DropDownItems) i.Checked = i.Text == settings.Hotkey.ToString();
    }

    void SetKey(Keys k)
    {
        bool was = hk.Registered;
        hk.Unregister();
        if (hk.Register(k))
        {
            if (!was) hk.Unregister(); // снова займём, когда откроется игра
            settings.Hotkey = k; settings.Save(); keyBusyShown = false;
            Pop("Клавиша снимка: " + k, "Нажимай её в игре, когда открыта акция на бирже", Blue, 4000);
        }
        else
        {
            if (was) hk.Register(settings.Hotkey);
            Pop("Клавиша " + k + " занята", "Её уже использует другая программа", Yellow, 5000);
        }
        RefreshMenu();
    }

    void TogglePower()
    {
        settings.On = !settings.On;
        settings.Save();
        if (!settings.On) hk.Unregister();
        Pop(settings.On ? "Помощник включён" : "Помощник выключен",
            settings.On ? "Снимай клавишей " + settings.Hotkey + " или кнопкой на панели" : "Клавиша " + settings.Hotkey + " снова работает в игре как обычно", settings.On ? Green : Gray, 3000);
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
        if (!settings.On) return;
        var game = Game.ClientOnScreen(Game.Window());
        var f = game.IsEmpty ? null : CurrentFrames(game.Size);
        WaitStable(f);
        string err;
        var full = GrabGame(out err);
        if (full == null) { Pop("Снимок не сделан", err, Red, 6000); return; }

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
                Pop("Эта акция уже снята", "нужен ещё раз — нажми " + settings.Hotkey + " снова", Gray, 4000);
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
            Pop("Снимок в очереди (" + bridge.Pending + ")", "открой сайт биржи — цены отправятся", Yellow, 7000);
        else if (calib)
            Pop("Первый снимок на этом экране", "ищу рамки, ~10 с", Blue, 30000);
        else
            Pop("Снимок сделан", "Распознаю на сайте…", Blue, 30000);
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
            Pop("Обнови сайт биржи", "нажми на его вкладке Ctrl+F5", Yellow, 12000);
            return;
        }
        var c = status == "ok" ? Green : status == "check" ? Yellow : Red;
        Pop(title ?? "", text ?? "", c, status == "ok" ? 4500 : 8000);
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
        if (game.IsEmpty) { Pop("MTA не найдена", "запусти игру", Yellow, 5000); return; }
        settings.PerRes.Remove(Settings.Key(game.Size));
        settings.Save();
        Pop("Рамки сброшены", "открой акцию и нажми " + settings.Hotkey, Blue, 6000);
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
            if (f.ShowDialog() == DialogResult.OK) Pop("Рамки сохранены", "Для экрана " + Settings.Key(shot.Size), Green, 3500);
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
        guard.Dispose();
        tray.Visible = false;
        ExitThread();
        Environment.Exit(0);
    }
}

// Клавиши скриншота (PrtSc, Alt/Win+PrtSc, Win+Shift+S): нажатие придерживаем, прячем
// панель и через мгновение повторяем ту же клавишу — снимок делается уже без панели.
class ScreenshotGuard : IDisposable
{
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct KB { public uint Vk, Scan, Flags, Time; public IntPtr Extra; }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    const int VK_SNAPSHOT = 0x2C, VK_S = 0x53;
    static readonly UIntPtr Mine = (UIntPtr)0x4E4358; // метка своих повторных нажатий
    readonly HookProc proc;                           // держим ссылку, иначе сборщик мусора уберёт
    readonly IntPtr hook;
    readonly Action<int> hide;
    int held;                                         // какую клавишу придержали (её отпускание тоже глотаем)

    public ScreenshotGuard(Action<int> hide)
    {
        this.hide = hide;
        proc = Proc;
        hook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, proc, GetModuleHandle(null), 0);
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    IntPtr Proc(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            var k = (KB)Marshal.PtrToStructure(l, typeof(KB));
            bool down = w == (IntPtr)0x100 || w == (IntPtr)0x104, up = w == (IntPtr)0x101 || w == (IntPtr)0x105;
            if ((ulong)k.Extra != (ulong)Mine)
            {
                int vk = (int)k.Vk;
                bool snip = vk == VK_S && (Down(0x5B) || Down(0x5C)) && Down(0x10);
                if (down && (vk == VK_SNAPSHOT || snip))
                {
                    hide(vk == VK_S ? 2500 : 1500);
                    held = vk;
                    var t = new System.Windows.Forms.Timer { Interval = 50 }; // кадр без панели успевает дойти до экрана
                    t.Tick += (s, e) =>
                    {
                        t.Stop(); t.Dispose();
                        // Win+Shift+S: если Win или Shift уже отпустили — нажимаем их сами, иначе в игру уйдёт просто «s»
                        bool win = snip && !Down(0x5B) && !Down(0x5C), shift = snip && !Down(0x10);
                        if (win) keybd_event(0x5B, 0, 0, Mine);
                        if (shift) keybd_event(0x10, 0, 0, Mine);
                        keybd_event((byte)vk, (byte)k.Scan, 0, Mine);
                        keybd_event((byte)vk, (byte)k.Scan, 2 /* KEYUP */, Mine);
                        if (shift) keybd_event(0x10, 0, 2, Mine);
                        if (win) keybd_event(0x5B, 0, 2, Mine);
                    };
                    t.Start();
                    return (IntPtr)1;
                }
                if (up && vk == held) { held = 0; return (IntPtr)1; }
            }
        }
        return CallNextHookEx(hook, code, w, l);
    }

    public void Dispose() { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
}

class HotkeyWindow : NativeWindow
{
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    public event Action Pressed;

    public HotkeyWindow() { CreateHandle(new CreateParams()); }

    public bool Registered { get; private set; }
    public bool Register(Keys k) { Registered = RegisterHotKey(Handle, 1, 0x4000 /* без автоповтора */, (uint)k); return Registered; }
    public void Unregister() { if (Registered) UnregisterHotKey(Handle, 1); Registered = false; }

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
