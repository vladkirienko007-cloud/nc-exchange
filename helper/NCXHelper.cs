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
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

static class Program
{
    public const string Version = "1.0";
    public const string Site = "https://vladkirienko007-cloud.github.io/nc-exchange/#/helper";

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        bool created;
        using (var m = new Mutex(true, "NCXHelper_single_instance", out created))
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

class Settings
{
    // Рамки — доли клиентской области окна игры (x, y, ширина, высота). По умолчанию —
    // планшет NC PAD при 16:9: шапка актива и ряд карточек с плашкой дивидендов/цикла.
    public static readonly RectangleF DefHeader = new RectangleF(0.325f, 0.338f, 0.325f, 0.068f);
    public static readonly RectangleF DefCards = new RectangleF(0.325f, 0.700f, 0.325f, 0.143f);

    public RectangleF Header = DefHeader;
    public RectangleF Cards = DefCards;
    public bool CardsOn = true;
    public bool Sound = true;
    public Keys Hotkey = Keys.F9;
    public List<string> Origins = new List<string> {
        "https://vladkirienko007-cloud.github.io", "http://localhost:8765", "http://127.0.0.1:8765" };

    static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NCXHelper"); } }
    static string FilePath { get { return Path.Combine(Dir, "settings.ini"); } }
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    static string R(RectangleF r) { return string.Join(",", new[] { r.X, r.Y, r.Width, r.Height }.Select(v => v.ToString("0.#####", Inv))); }
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
                if (i < 0) continue;
                string k = line.Substring(0, i).Trim(), v = line.Substring(i + 1).Trim();
                RectangleF r;
                if (k == "header" && TryR(v, out r)) s.Header = r;
                else if (k == "cards" && TryR(v, out r)) s.Cards = r;
                else if (k == "cardsOn") s.CardsOn = v != "0";
                else if (k == "sound") s.Sound = v != "0";
                else if (k == "hotkey") { Keys key; if (Enum.TryParse(v, out key)) s.Hotkey = key; }
                else if (k == "origin" && v.StartsWith("http")) s.Origins.Add(v.TrimEnd('/'));
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
            File.WriteAllLines(FilePath, new[] {
                "header=" + R(Header), "cards=" + R(Cards), "cardsOn=" + (CardsOn ? 1 : 0),
                "sound=" + (Sound ? 1 : 0), "hotkey=" + Hotkey,
                "# свой адрес сайта (если ссылка сменится): origin=https://..." }, Encoding.UTF8);
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

    public static Rectangle Part(Size s, RectangleF f)
    {
        var r = Rectangle.Round(new RectangleF(f.X * s.Width, f.Y * s.Height, f.Width * s.Width, f.Height * s.Height));
        r.Intersect(new Rectangle(Point.Empty, s));
        return r;
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
    public const int Port = 47615;
    readonly Settings settings;
    readonly Queue<Dictionary<string, object>> jobs = new Queue<Dictionary<string, object>>();
    readonly object gate = new object();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    DateTime lastPoll = DateTime.MinValue;
    int waiting;
    public event Action<Dictionary<string, object>> Result;
    public string Error;

    public Bridge(Settings s) { settings = s; }

    public bool SiteConnected
    {
        get { lock (gate) return waiting > 0 || (DateTime.Now - lastPoll).TotalSeconds < 35; }
    }

    public int Pending { get { lock (gate) return jobs.Count; } }

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
                if (method == "POST" && path == "/result")
                {
                    int len = 0;
                    string cl;
                    if (h.TryGetValue("Content-Length", out cl)) int.TryParse(cl, out len);
                    var body = ReadBody(s, Math.Min(len, 1 << 20));
                    var r = json.Deserialize<Dictionary<string, object>>(body);
                    Send(s, 200, origin, "{}");
                    if (r != null && Result != null) Result(r);
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
        Location = new Point(area.Right - Width - 24, area.Top + 24);
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
        header = s.Header; cards = s.Cards;
        Text = "Настройка рамок — NC Exchange помощник";
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
        save.Click += (o, e) => { s.Header = header; s.Cards = cards; s.CardsOn = cardsOn.Checked; s.Save(); DialogResult = DialogResult.OK; Close(); };
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

/* ---------------- приложение в трее ---------------- */

class HelperApp : ApplicationContext
{
    readonly Settings settings = Settings.Load();
    readonly Bridge bridge;
    readonly NotifyIcon tray;
    readonly Toast toast = new Toast();
    readonly HotkeyWindow hk;
    readonly ToolStripMenuItem statusItem, snapItem, keyMenu, soundItem;
    readonly Dictionary<string, Bitmap> lastShots = new Dictionary<string, Bitmap>();
    Bitmap lastFull;
    readonly System.Windows.Forms.Timer waitTimer = new System.Windows.Forms.Timer { Interval = 20000 };
    string waitingId;
    static readonly Keys[] KeyChoices = { Keys.F7, Keys.F9, Keys.F10, Keys.Insert, Keys.Home, Keys.Pause };

    static readonly Color Blue = Color.FromArgb(96, 165, 250), Green = Color.FromArgb(52, 211, 153),
        Yellow = Color.FromArgb(251, 191, 36), Red = Color.FromArgb(248, 113, 113);

    public HelperApp()
    {
        toast.CreateControl();
        var h = toast.Handle; // окно уведомлений нужно создать в UI-потоке заранее — через него идут BeginInvoke
        bridge = new Bridge(settings);
        bridge.Result += r => toast.BeginInvoke((Action)(() => OnResult(r)));
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
        menu.Items.AddRange(new ToolStripItem[] {
            statusItem, new ToolStripSeparator(), snapItem,
            new ToolStripMenuItem("Настроить рамки…", null, (s, e) => Setup()),
            keyMenu, soundItem, new ToolStripSeparator(),
            new ToolStripMenuItem("Открыть сайт биржи", null, (s, e) => OpenSite()),
            new ToolStripMenuItem("Выход", null, (s, e) => Quit()) });
        menu.Opening += (s, e) => RefreshMenu();

        tray = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
            Text = "NC Exchange помощник",
            ContextMenuStrip = menu,
            Visible = true
        };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Setup(); };

        hk = new HotkeyWindow();
        hk.Pressed += Snap;
        if (!hk.Register(settings.Hotkey))
            toast.Pop("Клавиша " + settings.Hotkey + " занята", "Выбери другую: правый клик по значку в трее → Горячая клавиша", Yellow, 8000);

        waitTimer.Tick += (s, e) =>
        {
            waitTimer.Stop();
            if (waitingId != null) toast.Pop("Сайт не ответил", "Открой сайт биржи на этом ПК — снимок отправится, как только он подключится", Yellow, 7000);
            waitingId = null;
        };

        if (bridge.Error != null) toast.Pop("Помощник не запустился", bridge.Error, Red, 10000);
        else toast.Pop("Помощник запущен", "Открой биржу в игре, выбери акцию и нажми " + settings.Hotkey, Blue, 6000);
        RefreshMenu();
    }

    void RefreshMenu()
    {
        statusItem.Text = (bridge.SiteConnected ? "● Сайт подключён" : "○ Сайт не открыт") + " · " + (Game.Window() != IntPtr.Zero ? "MTA найдена" : "MTA не запущена");
        snapItem.Text = "Снять биржу (" + settings.Hotkey + ")";
        soundItem.Checked = settings.Sound;
        foreach (ToolStripMenuItem i in keyMenu.DropDownItems) i.Checked = i.Text == settings.Hotkey.ToString();
    }

    void SetKey(Keys k)
    {
        hk.Unregister();
        if (hk.Register(k)) { settings.Hotkey = k; settings.Save(); toast.Pop("Клавиша снимка: " + k, "Нажимай её в игре, когда открыта акция на бирже", Blue, 4000); }
        else { hk.Register(settings.Hotkey); toast.Pop("Клавиша " + k + " занята", "Её уже использует другая программа", Yellow, 5000); }
        RefreshMenu();
    }

    Bitmap GrabGame(out string error)
    {
        error = null;
        var w = Game.Window();
        if (w == IntPtr.Zero) { error = "MTA не найдена — запусти игру"; return null; }
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

    void Snap()
    {
        string err;
        var full = GrabGame(out err);
        if (full == null) { toast.Pop("Снимок не сделан", err, Red, 6000); return; }
        if (settings.Sound) Shutter.Play();
        if (lastFull != null) lastFull.Dispose();
        lastFull = full;

        var images = new List<object>();
        var hr = Game.Part(full.Size, settings.Header);
        if (hr.Width > 10 && hr.Height > 10) images.Add(new Dictionary<string, object> { { "name", "header" }, { "data", Game.Png64(full, hr) } });
        if (settings.CardsOn)
        {
            var cr = Game.Part(full.Size, settings.Cards);
            if (cr.Width > 10 && cr.Height > 10) images.Add(new Dictionary<string, object> { { "name", "cards" }, { "data", Game.Png64(full, cr) } });
        }
        var id = DateTime.Now.Ticks.ToString("x");
        bridge.Push(new Dictionary<string, object> {
            { "id", id }, { "at", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds },
            { "width", full.Width }, { "height", full.Height }, { "images", images } });

        if (bridge.SiteConnected)
        {
            toast.Pop("Снимок сделан", "Распознаю на сайте…", Blue, 30000);
            waitingId = id;
            waitTimer.Stop(); waitTimer.Start();
        }
        else
            toast.Pop("Снимок сохранён", "Сайт биржи не открыт — открой его, и цены отправятся (в очереди: " + bridge.Pending + ")", Yellow, 7000);
    }

    void OnResult(Dictionary<string, object> r)
    {
        object v;
        string status = r.TryGetValue("status", out v) ? v as string : "";
        string title = r.TryGetValue("title", out v) ? v as string : "";
        string text = r.TryGetValue("text", out v) ? v as string : "";
        waitTimer.Stop();
        waitingId = null;
        var c = status == "ok" ? Green : status == "check" ? Yellow : Red;
        toast.Pop(title ?? "", text ?? "", c, status == "ok" ? 4500 : 8000);
    }

    void Setup()
    {
        Bitmap shot = lastFull;
        string err = null;
        if (shot == null) shot = GrabGame(out err);
        if (shot == null)
        {
            MessageBox.Show("Сначала открой биржу в игре, выбери любую акцию и нажми " + settings.Hotkey +
                " — рамки настраиваются по этому снимку.\n\n" + err, "Настройка рамок");
            return;
        }
        lastFull = shot;
        using (var f = new SetupForm(shot, settings))
            if (f.ShowDialog() == DialogResult.OK) toast.Pop("Рамки сохранены", "Следующие снимки будут по ним", Green, 3500);
    }

    static void OpenSite() { try { Process.Start(Program.Site); } catch { } }

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

// Короткий щелчок затвора — синтезируем, чтобы не таскать звуковой файл
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
        int n = rate * 90 / 1000;
        var rnd = new Random(7);
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + n * 2); w.Write(Encoding.ASCII.GetBytes("WAVE"));
        w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16); w.Write((short)1); w.Write((short)1);
        w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write(Encoding.ASCII.GetBytes("data")); w.Write(n * 2);
        for (int i = 0; i < n; i++)
        {
            double t = i / (double)rate;
            // два щелчка: открытие и закрытие шторки
            double env = Math.Exp(-t * 180) + (t > 0.045 ? 0.6 * Math.Exp(-(t - 0.045) * 220) : 0);
            w.Write((short)((rnd.NextDouble() * 2 - 1) * env * 9000));
        }
        return ms.ToArray();
    }
}
