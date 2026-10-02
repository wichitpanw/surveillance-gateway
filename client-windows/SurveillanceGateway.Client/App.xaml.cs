using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Services;
using Velopack;

namespace SurveillanceGateway.Client;

public partial class App : Application
{
    private LibVLC? _libVlc;
    private GatewayClient? _client;
    private Mutex? _singleInstance;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    /// <summary>Brings the copy that is already running to the front, so the click is not ignored.</summary>
    private static void RaiseExistingWindow()
    {
        var self = Process.GetCurrentProcess();
        var other = Process.GetProcessesByName(self.ProcessName)
            .FirstOrDefault(p => p.Id != self.Id && p.MainWindowHandle != IntPtr.Zero);

        if (other is null)
        {
            return;
        }

        const int ShowRestore = 9;
        ShowWindow(other.MainWindowHandle, ShowRestore);
        SetForegroundWindow(other.MainWindowHandle);
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        /*
            Velopack's own entry point, and it must be the first thing that runs.

            An installed build re-launches itself with hook arguments at install, update and
            uninstall time. This call handles those and exits the process; anything done before it
            runs during those invocations too, which for this app would mean starting libvlc and a
            window while the installer is still copying files.
        */
        VelopackApp.Build().Run();

        /*
            One copy per machine.

            Nothing stopped a second one being started - from the Start menu while the first was
            already on a wall - and each copy holds its own connections, its own decoders and its
            own instance id, so a key that an administrator reads as "two clients" would in fact
            be one person with the app open twice. The second copy raises the first and exits.

            A named mutex rather than a process scan: it is atomic, and two launches a fraction of
            a second apart (a double-clicked shortcut) would both pass a scan.
        */
        _singleInstance = new Mutex(initiallyOwned: true, "SurveillanceGateway.Client/single-instance", out var isFirst);
        if (!isFirst)
        {
            RaiseExistingWindow();
            Shutdown();
            return;
        }

        base.OnStartup(e);

        // Last line of defence. An exception from an event handler or an async void used to end
        // the process, and on a wall display that means a black screen until somebody notices.
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            LogError("AppDomain.UnhandledException", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            LogError("TaskScheduler.UnobservedTaskException", args.Exception);
            args.SetObserved();
        };

        // Finds libvlc.dll and its plugins/ tree in the output folder. Must run before any
        // LibVLC object is constructed.
        Core.Initialize();

        var settings = AppSettings.Load();

        // A wall-display machine gets provisioned unattended, so the address has to be settable
        // without anyone typing into the connect screen.
        var overrideUrl = e.Args
            .FirstOrDefault(a => a.StartsWith("--server=", StringComparison.OrdinalIgnoreCase));
        if (overrideUrl is not null)
        {
            var url = AppSettings.NormaliseServerUrl(overrideUrl["--server=".Length..]);
            var known = settings.Profiles.FirstOrDefault(p =>
                string.Equals(p.ServerUrl, url, StringComparison.OrdinalIgnoreCase));
            // Selects a saved key for that address if there is one; it never invents a profile,
            // because a gateway with no key here still needs someone to paste one in.
            if (known is not null) settings.ActiveProfileId = known.Id;
        }

        // Before any window exists: every view binds its text through Strings, so the language
        // has to be set while there is still nothing on screen to re-render.
        Strings.Current.SetLanguage(settings.Language);

        ApplyTheme(settings.Theme);

        // One LibVLC instance for the whole app: it owns the plugin cache and the decoder
        // configuration, and creating one per tile would load that tree dozens of times.
        //
        // --avcodec-hw=d3d11va is the point of the native client. It decodes on this machine's
        // GPU, which is why the gateway no longer has to transcode H.265 for this viewer.
        //
        // 500ms of jitter buffer, not the 200ms a pure low-latency tuning would pick. Part of
        // this fleet sits behind a WAN link, and at 200ms those streams tore and stuttered
        // because the buffer ran dry on every burst of jitter. Half a second of latency is
        // invisible on a wall and buys back a stable picture.
        //
        // --clock-jitter=0 and --clock-synchro=0 are deliberately absent. They switch off
        // libvlc's clock handling, which suits a local file and not a live camera whose packets
        // arrive unevenly; the frame pacing they produce is what reads as flicker.
        _libVlc = new LibVLC(
            "--avcodec-hw=d3d11va",
            "--network-caching=500",
            "--live-caching=500",
            "--rtsp-tcp",
            "--no-audio",
            "--quiet");

        _client = new GatewayClient();
        _client.Configure(
            settings.Active?.ServerUrl ?? string.Empty,
            settings.GetApiKey(),
            settings.InstanceId,
            Environment.MachineName);

        var window = new MainWindow(settings, _client, _libVlc);
        MainWindow = window;
        window.Show();
    }

    /// <summary>
    /// Swaps the token dictionary in slot 0 of the merged dictionaries.
    ///
    /// Both files define the same keys, so nothing else has to know a theme changed. This is
    /// also what will keep the native chrome in step with the embedded web view once that
    /// arrives: the SPA already takes a `theme` value, and both sides read the same setting.
    /// </summary>
    public static void ApplyTheme(string theme)
    {
        var source = theme == "light"
            ? "Themes/Tokens.Light.xaml"
            : "Themes/Tokens.Dark.xaml";

        var dictionaries = Current.Resources.MergedDictionaries;
        var tokens = new ResourceDictionary { Source = new Uri(source, UriKind.Relative) };

        if (dictionaries.Count == 0)
        {
            dictionaries.Add(tokens);
        }
        else
        {
            dictionaries[0] = tokens;
        }
    }

    /// <summary>
    /// An exception on the UI thread that nothing caught. It is logged and shown in the status
    /// bar, and the app keeps running: the views that are still fine (usually the whole wall)
    /// are worth more than a clean crash.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogError("DispatcherUnhandledException", e.Exception);
        try
        {
            (MainWindow as SurveillanceGateway.Client.MainWindow)?.ShowNotice(Strings.T("app.unexpectedError", e.Exception.Message));
        }
        catch (Exception)
        {
            // Showing the notice must never be the thing that fails next.
        }

        e.Handled = true;
    }

    private static readonly object LogLock = new();

    /// <summary>
    /// Appends an error to `errors.log` beside settings.json (%LOCALAPPDATA%\SurveillanceGateway.Client).
    /// The file starts over past 1 MB, so a loop of the same failure cannot fill the disk.
    /// </summary>
    public static void LogError(string where, Exception? ex)
    {
        try
        {
            var dir = Path.GetDirectoryName(AppSettings.FilePath);
            if (string.IsNullOrEmpty(dir)) return;
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, "errors.log");
            var line = $"{DateTimeOffset.Now:yyyy-MM-ddTHH:mm:ss.fffzzz} [{where}] {ex}{Environment.NewLine}";
            lock (LogLock)
            {
                if (File.Exists(path) && new FileInfo(path).Length > 1_000_000) File.Delete(path);
                File.AppendAllText(path, line);
            }
        }
        catch (Exception)
        {
            // Logging is best effort; a full disk or a locked file must not raise a second error.
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _singleInstance?.Dispose();
        _client?.Dispose();
        _libVlc?.Dispose();
        base.OnExit(e);
    }
}
