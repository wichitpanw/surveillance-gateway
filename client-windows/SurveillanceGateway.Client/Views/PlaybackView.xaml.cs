using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;
using VlcMediaPlayer = LibVLCSharp.Shared.MediaPlayer;

namespace SurveillanceGateway.Client.Views;

public sealed class PlaybackCameraGroup
{
    public string Name { get; init; } = string.Empty;
    public List<PlaybackCameraItem> Cameras { get; init; } = new();
    public int Count => Cameras.Count;
    public bool IsExpanded { get; init; }
}

public sealed class PlaybackCameraItem
{
    public V1Camera Camera { get; init; } = new();
    public string Name => Camera.DisplayName;
    public bool IsExpanded => false;
}

/// <summary>
/// ดูภาพย้อนหลังจาก API v1 โดยให้ gateway เก็บรหัสของอุปกรณ์ไว้ฝั่ง server
///
/// เส้นเวลาแสดงช่วงบันทึกของวันที่เลือก · ทุกการ seek เป็นคำขอใหม่ (อุปกรณ์อ่านจากเวลาจริง ไม่ใช่ไฟล์ที่ seek ได้)
/// เวลาที่แสดง = เวลาเริ่มของคำขอ + เวลาที่ libVLC เล่นไปแล้ว · เล่นจบก้อน (≤ 1 ชม.) แล้วขอก้อนถัดไปเอง
/// </summary>
public partial class PlaybackView : UserControl, IDisposable
{
    private static readonly TimeSpan Bangkok = TimeSpan.FromHours(7);
    private const int ChunkSeconds = 3600;
    private const int SkipSeconds = 30;
    private const int DaySeconds = 86400;

    private readonly GatewayClient _client;
    private readonly LibVLC _libVlc;
    private readonly VlcMediaPlayer _player;
    private readonly DispatcherTimer _clock;
    private IReadOnlyList<V1Camera> _cameras = Array.Empty<V1Camera>();
    private IReadOnlyList<(double Start, double End)> _ranges = Array.Empty<(double, double)>();
    private V1Camera? _selected;
    private DateTime _day = TodayBangkok();
    private DateTimeOffset? _playStart;
    private int _playDuration; // วินาทีที่ขอในก้อนที่เล่นอยู่ — ก้อนไม่ข้ามปลายช่วงบันทึกและไม่ข้ามเที่ยงคืน
    private double? _position;
    private CancellationTokenSource? _load;
    private CancellationTokenSource? _play;
    private bool _disposed;
    private string? _statusKey; // ข้อความสถานะล่าสุด (key) — เปลี่ยนภาษาแล้วแปลใหม่ได้ · null = ข้อความดิบจาก server
    private string? _statusTone;

    /// <summary>วันนี้ตามปฏิทินกรุงเทพ — ไม่พึ่งเขตเวลาของเครื่อง (ทุกเวลาในหน้านี้เป็น +07:00)</summary>
    private static DateTime TodayBangkok() => DateTimeOffset.UtcNow.ToOffset(Bangkok).Date;

    public PlaybackView(GatewayClient client, LibVLC libVlc)
    {
        InitializeComponent();
        _client = client;
        _libVlc = libVlc;
        _player = new VlcMediaPlayer(libVlc)
        {
            EnableHardwareDecoding = true,
            EnableMouseInput = false,
            EnableKeyInput = false,
        };
        Video.MediaPlayer = _player;
        _player.EncounteredError += (_, _) => Dispatcher.InvokeAsync(() => Status("playback.streamError", "crit"));
        _player.Playing += (_, _) => Dispatcher.InvokeAsync(() => { ShowPlaying(true); Status("playback.nowPlaying", "ok"); });
        _player.Paused += (_, _) => Dispatcher.InvokeAsync(() => { ShowPlaying(false); Status("playback.paused", "warn"); });
        _player.EndReached += (_, _) => Dispatcher.InvokeAsync(OnChunkEnded);

        _clock = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(250) };
        _clock.Tick += (_, _) => UpdateClock();
        _clock.Start();

        Timeline.SeekRequested += seconds => _ = PlayAtAsync(seconds);
        Strings.Current.PropertyChanged += OnLanguageChanged;
        ShowDay();
        Status("playback.idle", null);
    }

    public void SetCameras(IReadOnlyList<V1Camera> cameras)
    {
        _cameras = cameras;
        RebuildCameraTree();
    }

    private void RebuildCameraTree()
    {
        var query = SearchBox.Text.Trim();
        CameraTree.ItemsSource = _cameras
            .Where(c => query.Length == 0 || c.DisplayName.Contains(query, StringComparison.CurrentCultureIgnoreCase)
                || c.GroupLabel.Contains(query, StringComparison.CurrentCultureIgnoreCase)
                || c.Id.Contains(query, StringComparison.OrdinalIgnoreCase))
            .GroupBy(c => c.GroupLabel)
            .OrderBy(g => g.Key, StringComparer.CurrentCultureIgnoreCase)
            .Select(g => new PlaybackCameraGroup
            {
                Name = g.Key,
                IsExpanded = query.Length > 0,
                Cameras = g.OrderBy(c => c.DisplayName, StringComparer.CurrentCultureIgnoreCase)
                    .Select(c => new PlaybackCameraItem { Camera = c }).ToList(),
            }).ToList();
    }

    private void OnSearchChanged(object sender, TextChangedEventArgs e)
    {
        if (SearchPlaceholder is not null)
            SearchPlaceholder.Visibility = SearchBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (CameraTree is not null) RebuildCameraTree();
    }

    private void OnCameraSelected(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is not PlaybackCameraItem item) return;
        _selected = item.Camera;
        CameraTitle.Text = item.Camera.DisplayName;
        CameraSubtitle.Text = $"{item.Camera.GroupLabel} · {item.Camera.AvailabilityText}";
        StopPlayback();
        _position = null;
        _ = LoadRangesAsync();
    }

    // ---------- วันที่ ----------

    private void ShowDay()
    {
        var culture = Strings.Current.Language == "th" ? new CultureInfo("th-TH") { DateTimeFormat = { Calendar = new GregorianCalendar() } } : CultureInfo.GetCultureInfo("en-GB");
        DateText.Text = _day.ToString("ddd d MMM yyyy", culture);
    }

    /// <summary>เปลี่ยนภาษา → แปลวันที่ สรุปช่วงบันทึก และข้อความสถานะล่าสุดใหม่</summary>
    private void OnLanguageChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) =>
        Dispatcher.InvokeAsync(() =>
        {
            if (_disposed) return;
            ShowDay();
            ShowRangeSummary();
            if (_statusKey is not null) Status(_statusKey, _statusTone);
        });

    private void SetDay(DateTime day)
    {
        day = day.Date;
        if (day > TodayBangkok()) day = TodayBangkok();
        if (day == _day) return;
        _day = day;
        ShowDay();
        StopPlayback();
        _position = null;
        Timeline.ShowWholeDay();
        _ = LoadRangesAsync();
    }

    private void OnPreviousDay(object sender, RoutedEventArgs e) => SetDay(_day.AddDays(-1));
    private void OnNextDay(object sender, RoutedEventArgs e) => SetDay(_day.AddDays(1));
    private void OnToday(object sender, RoutedEventArgs e) => SetDay(TodayBangkok());

    private void OnOpenCalendar(object sender, RoutedEventArgs e)
    {
        DayCalendar.DisplayDateEnd = TodayBangkok();
        DayCalendar.SelectedDate = _day;
        DayCalendar.DisplayDate = _day;
        CalendarPopup.IsOpen = true;
    }

    private void OnCalendarPicked(object sender, SelectionChangedEventArgs e)
    {
        if (!CalendarPopup.IsOpen || DayCalendar.SelectedDate is not { } day) return;
        CalendarPopup.IsOpen = false;
        SetDay(day);
        // Calendar จับเมาส์ไว้หลังคลิก ต้องปล่อยไม่งั้นคลิกแรกนอก popup หาย
        Mouse.Capture(null);
    }

    private void OnRefresh(object sender, RoutedEventArgs e) => _ = LoadRangesAsync();

    /// <summary>เปิดหน้าต่างดาวน์โหลด โดยหยุดการเล่นเพื่อลดภาพที่ดึงซ้อนระหว่างส่งออก</summary>
    private void OnDownload(object sender, RoutedEventArgs e)
    {
        if (_selected is null || _disposed || _ranges.Count == 0)
        { Status("playback.downloadSelect", "warn"); return; }
        var second = CurrentSecond() ?? _ranges[0].Start;
        StopPlayback();
        new PlaybackDownloadWindow(_client, _selected, _day, second, _ranges)
        { Owner = Window.GetWindow(this) }.ShowDialog();
    }

    private DateTimeOffset AtSecond(double seconds) =>
        new DateTimeOffset(_day.Year, _day.Month, _day.Day, 0, 0, 0, Bangkok).AddSeconds(Math.Floor(seconds));

    private double SecondOfDay(DateTimeOffset time) =>
        (time.ToOffset(Bangkok) - new DateTimeOffset(_day.Year, _day.Month, _day.Day, 0, 0, 0, Bangkok)).TotalSeconds;

    /// <summary>โหลดช่วงบันทึกเฉพาะกล้องและวันที่เลือก พร้อมยกเลิกคำขอเก่าเมื่อเปลี่ยนตัวเลือก</summary>
    private async Task LoadRangesAsync()
    {
        if (_selected is null || _disposed) return;
        _load?.Cancel();
        _load?.Dispose();
        _load = new CancellationTokenSource();
        var ct = _load.Token;
        var cameraId = _selected.Id;
        var day = _day;
        _ranges = Array.Empty<(double, double)>();
        Timeline.Ranges = _ranges;
        RangeSummary.Text = string.Empty;
        Status("playback.loading", null);
        try
        {
            var from = AtSecond(0);
            var list = await _client.GetRecordingsAsync(cameraId, from, from.AddDays(1), ct);
            if (ct.IsCancellationRequested || _selected?.Id != cameraId || _day != day || _disposed) return;
            _ranges = list.Ranges
                .Select(r => (Math.Max(0, SecondOfDay(r.Start)), Math.Min(86400, SecondOfDay(r.End))))
                .Where(r => r.Item2 > r.Item1)
                .OrderBy(r => r.Item1)
                .ToList();
            Timeline.Ranges = _ranges;
            ShowRangeSummary();
            if (_ranges.Count == 0)
            {
                Status("playback.empty", "warn");
                return;
            }
            // ยังไม่ได้เลือกเวลา → ชี้ที่ต้นช่วงแรก ผู้ใช้กดเล่นได้ทันที
            if (_position is null) MoveCursor(_ranges[0].Start);
            Status("playback.ready", null);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            if (!ct.IsCancellationRequested && !_disposed) SetStatus(ex.Message, "crit");
        }
    }

    /// <summary>สรุปจำนวนช่วงและเวลารวมของวันที่เลือก (ว่างถ้าไม่มีช่วง)</summary>
    private void ShowRangeSummary()
    {
        var total = TimeSpan.FromSeconds(_ranges.Sum(r => r.End - r.Start));
        RangeSummary.Text = _ranges.Count == 0 ? string.Empty
            : string.Format(Strings.T("playback.summary"), _ranges.Count, $"{(int)total.TotalHours}:{total.Minutes:00}");
    }

    // ---------- เล่น ----------

    private void MoveCursor(double seconds)
    {
        _position = Math.Clamp(seconds, 0, 86399);
        Timeline.Playhead = _position;
        TimeBox.Text = TimeSpan.FromSeconds(Math.Floor(_position.Value)).ToString(@"hh\:mm\:ss");
        ClockText.Text = TimeBox.Text;
    }

    /// <summary>เวลาที่กำลังเล่นอยู่ (วินาทีของวัน) จากเวลาเริ่มของคำขอ + ที่ libVLC เล่นไปแล้ว</summary>
    private double? CurrentSecond()
    {
        if (_playStart is not { } start || _player.Media is null) return _position;
        // ไม่เกินความยาวที่ขอ และไม่เกินเที่ยงคืนของวันที่เลือก
        var played = Math.Min(Math.Max(0, _player.Time) / 1000.0, _playDuration);
        return Math.Min(SecondOfDay(start) + played, DaySeconds);
    }

    private void UpdateClock()
    {
        if (_disposed || _playStart is null || !_player.IsPlaying) return;
        if (CurrentSecond() is not { } now) return;
        _position = Math.Min(now, 86399);
        Timeline.Playhead = _position;
        ClockText.Text = TimeSpan.FromSeconds(Math.Floor(_position.Value)).ToString(@"hh\:mm\:ss");
        if (!TimeBox.IsKeyboardFocused) TimeBox.Text = ClockText.Text;
    }

    /// <summary>เริ่มเล่นใหม่ ณ วินาทีของวันที่เลือก · ช่วงไม่มีภาพเลื่อนไปต้นช่วงถัดไป</summary>
    private async Task PlayAtAsync(double seconds)
    {
        if (_selected is null || _disposed) return;
        var target = SnapToRecording(seconds);
        if (target is null)
        {
            MoveCursor(seconds);
            Status("playback.noVideoHere", "warn");
            return;
        }
        StopPlayback();
        MoveCursor(target.Value);
        var cameraId = _selected.Id;
        var at = AtSecond(target.Value);
        var duration = ChunkDuration(target.Value);
        _play?.Dispose();
        _play = new CancellationTokenSource();
        var ct = _play.Token;
        Status("playback.playing", null);
        PlayButton.IsEnabled = false;
        try
        {
            var url = await _client.GetPlaybackUrlAsync(cameraId, at, duration, ct);
            if (_disposed || ct.IsCancellationRequested || _selected?.Id != cameraId) return;
            using var media = new Media(_libVlc, new Uri(url));
            media.AddOption(":network-caching=1000");
            // Playback stays picture-only, as it was under the old global --no-audio.
            media.AddOption(":no-audio");
            _playStart = at;
            _playDuration = duration;
            _player.Play(media);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            if (!_disposed) SetStatus(ex.Message, "crit");
        }
        finally
        {
            if (!_disposed) PlayButton.IsEnabled = true;
        }
    }

    /// <summary>
    /// เวลาที่เล่นได้จริง: อยู่ในช่วงบันทึก = เวลาเดิม · อยู่ในช่องว่าง = ต้นช่วงถัดไป · หลังช่วงสุดท้าย = null
    /// ยังโหลดช่วงไม่เสร็จ (ไม่มีข้อมูล) ให้ลองตามที่ขอ อุปกรณ์ตอบเองว่ามีภาพหรือไม่
    /// </summary>
    /// <summary>
    /// ความยาวก้อนที่ขอ (วินาทีเต็ม ≥ 1): ไม่เกิน 1 ชม. · ไม่เกินปลายช่วงบันทึกที่เวลานี้อยู่ · ไม่ข้ามเที่ยงคืน
    /// ยังไม่รู้ช่วง (โหลดไม่เสร็จ) จำกัดแค่ 1 ชม. และเที่ยงคืน
    /// </summary>
    private int ChunkDuration(double target)
    {
        var limit = Math.Min(ChunkSeconds, DaySeconds - target);
        foreach (var (start, end) in _ranges)
        {
            if (target >= start && target < end)
            {
                limit = Math.Min(limit, end - target);
                break;
            }
        }
        return Math.Max(1, (int)Math.Floor(limit));
    }

    private double? SnapToRecording(double seconds)
    {
        if (_ranges.Count == 0) return seconds;
        foreach (var (start, end) in _ranges)
        {
            if (seconds < start) return start;
            if (seconds < end) return seconds;
        }
        return null;
    }

    private void OnPlayPause(object sender, RoutedEventArgs e)
    {
        if (_player.IsPlaying) _player.Pause();
        else if (_player.Media is not null && _player.State == VLCState.Paused) _player.Play();
        else _ = PlayAtAsync(_position ?? (_ranges.Count > 0 ? _ranges[0].Start : 0));
    }

    private void OnStop(object sender, RoutedEventArgs e)
    {
        StopPlayback();
        Status("playback.stopped", null);
    }

    public void StopPlayback()
    {
        _play?.Cancel();
        if (CurrentSecond() is { } now && _playStart is not null) MoveCursor(now);
        _playStart = null;
        _player.Stop();
        ShowPlaying(false);
    }

    private void OnBack(object sender, RoutedEventArgs e) => _ = PlayAtAsync(Math.Max(0, (CurrentSecond() ?? 0) - SkipSeconds));

    private void OnForward(object sender, RoutedEventArgs e) => _ = PlayAtAsync((CurrentSecond() ?? 0) + SkipSeconds);

    private void OnPreviousRecording(object sender, RoutedEventArgs e)
    {
        var now = CurrentSecond() ?? 86400;
        // ต้นช่วงก่อนหน้า (เผื่อ 5 วิ: กดขณะอยู่ต้นช่วงแล้วต้องถอยไปช่วงก่อนจริง ๆ)
        var previous = _ranges.Where(r => r.Start < now - 5).Select(r => r.Start).DefaultIfEmpty(double.NaN).Max();
        if (!double.IsNaN(previous)) _ = PlayAtAsync(previous);
    }

    private void OnNextRecording(object sender, RoutedEventArgs e)
    {
        var now = CurrentSecond() ?? -1;
        var next = _ranges.Where(r => r.Start > now + 1).Select(r => r.Start).DefaultIfEmpty(double.NaN).Min();
        if (!double.IsNaN(next)) _ = PlayAtAsync(next);
    }

    private void OnGoTo(object sender, RoutedEventArgs e)
    {
        if (!TimeSpan.TryParse(TimeBox.Text, CultureInfo.InvariantCulture, out var clock) || clock < TimeSpan.Zero || clock >= TimeSpan.FromDays(1))
        {
            Status("playback.badTime", "warn");
            return;
        }
        _ = PlayAtAsync(clock.TotalSeconds);
    }

    private void OnTimeBoxKey(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        OnGoTo(sender, e);
        e.Handled = true;
    }

    /// <summary>
    /// ก้อนภาพจบ (ครบชั่วโมง หรือถึงปลายช่วงบันทึก) → เล่นต่อที่เวลาถัดไป / ต้นช่วงถัดไป · ถึงเที่ยงคืน = หยุด
    /// </summary>
    private void OnChunkEnded()
    {
        if (_disposed || _playStart is not { } start) return;
        var startSecond = SecondOfDay(start);
        var expectedEnd = startSecond + _playDuration;
        var reached = CurrentSecond() ?? startSecond;
        // เวลาของ libVLC ตามไม่ทันปลายก้อนเสมอ — เล่นเกือบครบถือว่าครบ ไม่งั้นขอก้อนสั้นซ้ำที่ปลายช่วง
        if (expectedEnd - reached < 5) reached = expectedEnd;
        _playStart = null;
        ShowPlaying(false);
        if (reached >= DaySeconds - 1)
        {
            MoveCursor(DaySeconds - 1);
            Status("playback.endOfDay", null);
            return;
        }
        // เล่นได้ไม่ถึง 5 วิ = อุปกรณ์ไม่มีภาพให้จริง · ขอซ้ำจะวนไม่จบ
        if (reached - startSecond < 5 || SnapToRecording(reached) is not { } next)
        {
            MoveCursor(reached);
            Status("playback.ended", null);
            return;
        }
        _ = PlayAtAsync(next);
    }

    private void OnZoomIn(object sender, RoutedEventArgs e) => Timeline.Zoom(0.5);
    private void OnZoomOut(object sender, RoutedEventArgs e) => Timeline.Zoom(2);
    private void OnZoomFit(object sender, RoutedEventArgs e) => Timeline.ShowWholeDay();

    private void ShowPlaying(bool playing)
    {
        PlayIcon.Visibility = playing ? Visibility.Collapsed : Visibility.Visible;
        PauseIcon.Visibility = playing ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>ข้อความสถานะ + จุดสี (ok / warn / crit / null = เทา)</summary>
    private void SetStatus(string text, string? tone)
    {
        _statusKey = null;
        ShowStatus(text, tone);
    }

    /// <summary>ข้อความสถานะจาก key ใน Strings — จำไว้แปลใหม่ตอนเปลี่ยนภาษา</summary>
    private void Status(string key, string? tone)
    {
        _statusKey = key;
        _statusTone = tone;
        ShowStatus(Strings.T(key), tone);
    }

    private void ShowStatus(string text, string? tone)
    {
        StatusText.Text = text;
        StateDot.Fill = (System.Windows.Media.Brush)FindResource(tone switch
        {
            "ok" => "StatusOkBrush",
            "warn" => "StatusWarnBrush",
            "crit" => "StatusCritBrush",
            _ => "FaintForegroundBrush",
        });
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Strings.Current.PropertyChanged -= OnLanguageChanged;
        _clock.Stop();
        _load?.Cancel();
        _load?.Dispose();
        _play?.Cancel();
        _play?.Dispose();
        _player.Stop();
        Video.MediaPlayer = null;
        _player.Dispose();
    }
}
