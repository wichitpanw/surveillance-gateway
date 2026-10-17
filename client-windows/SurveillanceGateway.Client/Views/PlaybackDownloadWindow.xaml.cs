using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows;
using Microsoft.Win32;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>เลือกช่วงย้อนหลังในวันที่เปิดอยู่ บันทึก MP4 และยกเลิกงานได้</summary>
public partial class PlaybackDownloadWindow : Window
{
    private readonly GatewayClient _client;
    private readonly V1Camera _camera;
    private readonly DateTime _day;
    private readonly IReadOnlyList<(double Start, double End)> _ranges;
    private CancellationTokenSource? _download;
    private bool _busy;
    private bool _closeWhenDone;

    public PlaybackDownloadWindow(GatewayClient client, V1Camera camera, DateTime day,
        double second, IReadOnlyList<(double Start, double End)> ranges, double? selectedEnd = null)
    {
        InitializeComponent();
        _client = client; _camera = camera; _day = day; _ranges = ranges;
        CameraText.Text = camera.DisplayName;
        DayText.Text = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + " (+07:00)";
        var start = (int)Math.Clamp(second, 0, 86398);
        var end = Math.Min(start + 300, 86399);
        foreach (var range in ranges)
            if (start >= range.Start && start < range.End) { end = Math.Min(end, (int)range.End); break; }
        if(selectedEnd is not null) end = (int)Math.Clamp(selectedEnd.Value, 0, 86399);
        StartBox.Text = TimeSpan.FromSeconds(start).ToString(@"hh\:mm\:ss");
        EndBox.Text = TimeSpan.FromSeconds(Math.Min(end, 86399)).ToString(@"hh\:mm\:ss");
    }

    /// <summary>ตรวจช่วงเวลาและช่วงบันทึกก่อนเลือกไฟล์ แล้วดาวน์โหลดโดยไม่บล็อก UI</summary>
    private async void OnDownload(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        if (!TimeSpan.TryParseExact(StartBox.Text.Trim(), @"hh\:mm\:ss", CultureInfo.InvariantCulture, out var start)
            || !TimeSpan.TryParseExact(EndBox.Text.Trim(), @"hh\:mm\:ss", CultureInfo.InvariantCulture, out var end))
        { DownloadStatus.Text = Strings.T("playback.badTime"); return; }
        var seconds = (int)(end - start).TotalSeconds;
        if (seconds < 1 || seconds > 1800)
        { DownloadStatus.Text = Strings.T("playback.downloadLimit"); return; }
        // รวมช่วงที่ติดกันเพื่อไม่ปฏิเสธการบันทึกที่อุปกรณ์แบ่งเป็นหลายไฟล์
        var covered = start.TotalSeconds;
        foreach (var range in _ranges.OrderBy(r => r.Start))
        {
            if (range.End <= covered) continue;
            if (range.Start > covered) break;
            covered = Math.Max(covered, range.End);
            if (covered >= end.TotalSeconds) break;
        }
        if (covered < end.TotalSeconds)
        { DownloadStatus.Text = Strings.T("playback.downloadGap"); return; }
        var safeName = string.Concat(_camera.DisplayName.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c));
        var save = new SaveFileDialog {
            Title = Strings.T("playback.download"), Filter = Strings.T("playback.downloadFilter"),
            DefaultExt = ".mp4", AddExtension = true, OverwritePrompt = true,
            FileName = $"{safeName}_{_day:yyyyMMdd}_{start:hhmmss}-{end:hhmmss}.mp4",
        };
        if (save.ShowDialog(this) != true) return;
        _download = new CancellationTokenSource();
        _busy = true;
        DownloadButton.IsEnabled = false; TimeFields.IsEnabled = false;
        DownloadProgress.Visibility = Visibility.Visible;
        CancelButton.Content = Strings.T("playback.downloadCancel");
        DownloadStatus.Text = Strings.T("playback.downloadPreparing");
        try
        {
            var at = new DateTimeOffset(_day.Year, _day.Month, _day.Day, 0, 0, 0, TimeSpan.FromHours(7)).Add(start);
            var progress = new Progress<long>(bytes => {
                if (_busy) DownloadStatus.Text = string.Format(Strings.T("playback.downloadProgress"), bytes / 1000000.0);
            });
            await _client.DownloadPlaybackAsync(_camera.Id, at, seconds, save.FileName, progress, _download.Token);
            try { await ClientDiagnostics.WriteEvidenceAsync(save.FileName, _camera, at, seconds, _download.Token);
                DownloadStatus.Text = Strings.T("evidence.saved", save.FileName); }
            catch (Exception) { DownloadStatus.Text = Strings.T("evidence.manifestFailed", save.FileName); }
        }
        catch (OperationCanceledException) { DownloadStatus.Text = Strings.T("playback.downloadCancelled"); }
        catch (Exception ex) { DownloadStatus.Text = ex.Message; }
        finally
        {
            _busy = false; _download.Dispose(); _download = null;
            DownloadButton.IsEnabled = true; TimeFields.IsEnabled = true;
            DownloadProgress.Visibility = Visibility.Collapsed;
            CancelButton.Content = Strings.T("playback.downloadClose");
            if (_closeWhenDone) Close();
        }
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        if (_busy) _download?.Cancel(); else Close();
    }

    /// <summary>ปิดหน้าต่างระหว่างดาวน์โหลด → ยกเลิกและรอล้างไฟล์บางส่วนให้เสร็จก่อน</summary>
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (!_busy) return;
        e.Cancel = true; _closeWhenDone = true; _download?.Cancel();
    }
}
