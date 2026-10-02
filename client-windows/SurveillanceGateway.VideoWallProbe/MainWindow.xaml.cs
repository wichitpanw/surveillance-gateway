using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using VlcMediaPlayer = LibVLCSharp.Shared.MediaPlayer;
using LibVLCSharp.WPF;

namespace SurveillanceGateway.VideoWallProbe;

/// <summary>
/// M1 harness: nine hardware-decoded H.265 RTSP streams in a fixed 3x3 grid.
/// It has no login, no navigation and no design system on purpose - the only question it
/// answers is whether the stack can hold nine passthrough streams smoothly.
///
/// The window reports to a CSV so a run can be judged without watching it: pass
/// --log=&lt;path&gt; and --seconds=&lt;n&gt; to have it sample and then close on its own.
/// </summary>
public partial class MainWindow : Window
{
    private const int CellCount = 9;

    private readonly List<Cell> _cells = new();
    private readonly DispatcherTimer _sampler = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly Process _self = Process.GetCurrentProcess();
    private readonly Stopwatch _uptime = Stopwatch.StartNew();

    private LibVLC? _libVlc;
    private string? _logPath;
    private TimeSpan _lastCpu;
    private DateTime _lastSampleAt;
    private double _autoCloseSeconds;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        var args = ParseArgs();
        _logPath = args.TryGetValue("log", out var log) ? log : null;
        _autoCloseSeconds = args.TryGetValue("seconds", out var secs)
            && double.TryParse(secs, NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed)
                ? parsed
                : 0;

        var urls = LoadUrls(args.TryGetValue("streams", out var file) ? file : null);

        // --avcodec-hw=d3d11va is the whole point of going native: DXVA2/D3D11VA decode into a
        // GPU surface, with no per-frame copy into managed memory. The caching values trade
        // jitter tolerance for latency, which is the right trade for a live wall.
        _libVlc = new LibVLC(
            "--avcodec-hw=d3d11va",
            "--network-caching=200",
            "--live-caching=200",
            "--rtsp-tcp",
            "--clock-jitter=0",
            "--clock-synchro=0",
            "--no-audio",
            "--quiet");

        for (var i = 0; i < CellCount; i++)
        {
            var url = i < urls.Count ? urls[i] : null;
            _cells.Add(BuildCell(i, url));
        }

        HeaderText.Text = $"9 cells - libvlc {_libVlc.Version} - d3d11va - network-caching=200";
        _lastCpu = _self.TotalProcessorTime;
        _lastSampleAt = DateTime.UtcNow;

        WriteLogLine("elapsed_s,cell,url,state,decoded,displayed,lost,fps,cpu_pct,rss_mb");

        _sampler.Tick += OnSample;
        _sampler.Start();

        foreach (var cell in _cells)
        {
            cell.Start();
        }
    }

    private Cell BuildCell(int index, string? url)
    {
        var caption = new TextBlock
        {
            FontFamily = new FontFamily("Consolas"),
            FontSize = 12,
            Foreground = new SolidColorBrush(Color.FromRgb(0xE5, 0xEE, 0xF6)),
            Margin = new Thickness(8, 6, 8, 6),
            VerticalAlignment = VerticalAlignment.Top,
            HorizontalAlignment = HorizontalAlignment.Left,
            Text = url is null ? $"{index + 1}: (no stream)" : $"{index + 1}: connecting..."
        };

        var videoView = new VideoView
        {
            // VideoView.Content renders in a transparent floating window layered over the video
            // HWND. It is the only way to draw over the picture: nothing in the WPF visual tree
            // can appear on top of an HwndHost.
            Content = new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(0x99, 0x00, 0x00, 0x00)),
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(2),
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(8),
                Child = caption
            }
        };

        var frame = new Border
        {
            Margin = new Thickness(4),
            Background = Brushes.Black,
            BorderBrush = new SolidColorBrush(Color.FromRgb(0x1F, 0x2A, 0x37)),
            BorderThickness = new Thickness(1),
            Child = videoView
        };

        Wall.Children.Add(frame);

        VlcMediaPlayer? player = null;
        if (url is not null)
        {
            player = new VlcMediaPlayer(_libVlc!) { EnableHardwareDecoding = true };
            videoView.MediaPlayer = player;
        }

        return new Cell(index, url, player, caption, _libVlc!);
    }

    private void OnSample(object? sender, EventArgs e)
    {
        var now = DateTime.UtcNow;
        var cpuNow = _self.TotalProcessorTime;
        var wall = (now - _lastSampleAt).TotalSeconds;
        var cpuPct = wall > 0
            ? (cpuNow - _lastCpu).TotalSeconds / (wall * Environment.ProcessorCount) * 100.0
            : 0;
        _lastCpu = cpuNow;
        _lastSampleAt = now;

        var rssMb = _self.WorkingSet64 / 1024.0 / 1024.0;
        var elapsed = _uptime.Elapsed.TotalSeconds;

        var playing = 0;
        var totalFps = 0.0;
        var totalLost = 0L;

        foreach (var cell in _cells)
        {
            var snap = cell.Sample(wall);
            if (snap.IsPlaying)
            {
                playing++;
            }

            totalFps += snap.Fps;
            totalLost += snap.Lost;

            WriteLogLine(string.Join(",",
                elapsed.ToString("F1", CultureInfo.InvariantCulture),
                cell.Index + 1,
                Quote(cell.Url ?? string.Empty),
                snap.State,
                snap.Decoded,
                snap.Displayed,
                snap.Lost,
                snap.Fps.ToString("F1", CultureInfo.InvariantCulture),
                cpuPct.ToString("F1", CultureInfo.InvariantCulture),
                rssMb.ToString("F0", CultureInfo.InvariantCulture)));
        }

        StatusText.Text =
            $"t+{elapsed:F0}s - playing {playing}/{CellCount} - {totalFps:F0} fps total - "
            + $"lost {totalLost} - cpu {cpuPct:F1}% - rss {rssMb:F0} MB";

        if (_autoCloseSeconds > 0 && elapsed >= _autoCloseSeconds)
        {
            Close();
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\"\"") + "\"";
    }

    private void WriteLogLine(string line)
    {
        if (_logPath is null)
        {
            return;
        }

        try
        {
            File.AppendAllText(_logPath, line + Environment.NewLine, Encoding.UTF8);
        }
        catch (IOException)
        {
            // A probe that dies because its own log file was momentarily locked would be worse
            // than a missing sample.
        }
    }

    private static Dictionary<string, string> ParseArgs()
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var arg in Environment.GetCommandLineArgs().Skip(1))
        {
            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            var body = arg.Substring(2);
            var eq = body.IndexOf('=');
            if (eq <= 0)
            {
                result[body] = "true";
            }
            else
            {
                result[body.Substring(0, eq)] = body.Substring(eq + 1);
            }
        }

        return result;
    }

    private static List<string> LoadUrls(string? path)
    {
        var candidate = path ?? Path.Combine(AppContext.BaseDirectory, "streams.txt");
        if (File.Exists(candidate))
        {
            return File.ReadAllLines(candidate)
                .Select(l => l.Trim())
                .Where(l => l.Length > 0 && !l.StartsWith("#", StringComparison.Ordinal))
                .Take(CellCount)
                .ToList();
        }

        return Enumerable.Range(1, CellCount)
            .Select(i => $"rtsp://127.0.0.1:8557/raw{i}")
            .ToList();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _sampler.Stop();
        foreach (var cell in _cells)
        {
            cell.Dispose();
        }

        _libVlc?.Dispose();
    }
}
