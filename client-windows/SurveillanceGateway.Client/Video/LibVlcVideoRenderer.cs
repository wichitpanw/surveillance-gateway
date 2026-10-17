using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using SurveillanceGateway.Client.Services;
using LibVLCSharp.Shared;
using VlcMediaPlayer = LibVLCSharp.Shared.MediaPlayer;

namespace SurveillanceGateway.Client.Video;

/// <summary>
/// LibVLC-backed renderer, with the reconnect state machine ported from
/// src/components/LiveStreamPlayer.jsx.
///
/// Three behaviours in that file are bug fixes learned on displays left running for days, and
/// are reproduced here deliberately rather than reinvented:
///
///   1. The retry budget resets when the tile changes camera. Without it, a tile that burned
///      its retries on a flaky camera stays dead, and dropping a healthy camera into that tile
///      inherits the exhausted budget and fails on its first hiccup.
///   2. The retry counter resets when actual frames arrive, so the maximum means "failed N times
///      in a row", not "failed N times since the window opened" - a ceiling any wall display
///      reaches eventually.
///   3. A watchdog runs alongside the error event, because "no picture" does not always raise
///      an error. libvlc can sit in Opening on an unreachable camera indefinitely.
/// </summary>
public sealed class LibVlcVideoRenderer : IVideoRenderer
{
    private const int MaxRetries = 8;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan Watchdog = TimeSpan.FromSeconds(12);

    private readonly LibVLC _libVlc;
    private readonly VlcMediaPlayer _player;
    private readonly DispatcherTimer _watchdog;
    private readonly DispatcherTimer _retryTimer;

    private Func<CancellationToken, Task<string?>>? _urlProvider;
    private CancellationTokenSource? _attempt;
    private string? _ownerKey;
    private int _retryCount;
    public int Reconnects { get; private set; }
    public string? LastFailure { get; private set; }
    private long _lastDisplayed;
    private double _framelessSeconds;
    private bool _disposed;

    public LibVlcVideoRenderer(LibVLC libVlc)
    {
        _libVlc = libVlc;
        /*
            libvlc must not take the mouse or the keyboard.

            By default it grabs both on its video window: right-click opens VLC's own menu, and
            because that window sits under the VideoView's overlay, the click never reaches ours -
            the cell menu could not be opened by any means. Mouse-over was lost the same way, which
            is why the cell's hover controls came and went.

            This client gives the picture no interactions of its own; every control around it is
            WPF. Handing input back is what makes those controls reachable.
        */
        _player = new VlcMediaPlayer(_libVlc)
        {
            EnableHardwareDecoding = true,
            EnableMouseInput = false,
            EnableKeyInput = false,
        };
        _player.EncounteredError += (_, _) => Dispatch(() => OnFailure(Strings.T("video.streamError")));
        _player.EndReached += (_, _) => Dispatch(() => OnFailure(Strings.T("video.streamEnded")));
        _player.Playing += (_, _) => Dispatch(OnPlaying);
        _player.ESAdded += (_, e) =>
        {
            if (e.Type == TrackType.Audio) Dispatch(() => _player.Mute = _muted);
        };

        _watchdog = new DispatcherTimer { Interval = Watchdog };
        _watchdog.Tick += (_, _) =>
        {
            _watchdog.Stop();
            if (State == VideoState.Connecting)
            {
                OnFailure(Strings.T("video.noPicture"));
            }
        };

        _retryTimer = new DispatcherTimer { Interval = RetryDelay };
        _retryTimer.Tick += (_, _) =>
        {
            _retryTimer.Stop();
            StartPlayback();
        };
    }

    /// <summary>The player this renderer drives, for handing to a VideoView.</summary>
    public VlcMediaPlayer Player => _player;

    public VideoState State { get; private set; } = VideoState.Idle;

    public double Fps { get; private set; }

    public long LostPictures { get; private set; }

    public bool AudioAvailable { get; set; }

    private bool _muted = true;

    /*
      Mute is applied to the player again whenever playback (re)starts, not only here: libvlc
      ignores a mute set before the audio output exists, and every reconnect builds a new one.
      A cell that came back from a dropped stream would otherwise start talking by itself.
    */
    public bool Muted
    {
        get => _muted;
        set
        {
            _muted = value;
            _player.Mute = value;
        }
    }

    public event EventHandler<VideoStateChangedEventArgs>? StateChanged;

    public void Play(Func<CancellationToken, Task<string?>> urlProvider, string ownerKey)
    {
        // Point 1 above: a different camera in this tile gets a fresh budget.
        if (_ownerKey != ownerKey)
        {
            _ownerKey = ownerKey;
            _retryCount = 0;
            Reconnects = 0;
            LastFailure = null;
        }

        _urlProvider = urlProvider;
        _lastDisplayed = 0;
        Fps = 0;
        LostPictures = 0;
        StartPlayback();
    }

    public void Stop()
    {
        _retryTimer.Stop();
        _watchdog.Stop();
        CancelAttempt();
        _urlProvider = null;
        Fps = 0;
        _framelessSeconds = 0;

        try
        {
            _player.Stop();
        }
        catch (Exception ex) when (ex is VLCException or ObjectDisposedException)
        {
            // Stopping a player that already tore itself down is not an error worth surfacing.
        }

        SetState(VideoState.Idle, null);
    }

    public void Poll(double elapsedSeconds)
    {
        if (_disposed || elapsedSeconds <= 0)
        {
            return;
        }

        var media = _player.Media;
        if (media is null)
        {
            Fps = 0;
            return;
        }

        var stats = media.Statistics;
        var displayed = stats.DisplayedPictures;
        var delta = displayed - _lastDisplayed;
        // libvlc resets these counters when a stream restarts, so a negative delta is a restart,
        // not a stall.
        Fps = delta >= 0 ? delta / elapsedSeconds : 0;
        _lastDisplayed = displayed;
        LostPictures = stats.LostPictures;

        // นับภาพค้างเฉพาะตอนเล่นจริง — pause/buffering และตัวนับที่เพิ่ง reset ไม่ใช่ภาพค้าง
        if (State != VideoState.Playing || _player.State != VLCState.Playing || delta < 0)
        {
            _framelessSeconds = 0;
            return;
        }
        if (delta > 0)
        {
            _framelessSeconds = 0;
            _retryCount = 0;
            return;
        }
        _framelessSeconds += elapsedSeconds;
        if (_framelessSeconds >= Watchdog.TotalSeconds)
        {
            _framelessSeconds = 0;
            OnFailure(Strings.T("video.framesStalled"));
        }
    }

    private void StartPlayback()
    {
        if (_disposed || _urlProvider is null)
        {
            return;
        }

        _retryTimer.Stop();
        _watchdog.Stop();
        _framelessSeconds = 0;
        SetState(VideoState.Connecting, Strings.T("video.connecting"));

        CancelAttempt();
        var attempt = new CancellationTokenSource();
        _attempt = attempt;

        // Fetching the URL is a network call of its own, so it cannot block the UI thread. The
        // watchdog does not start until playback has actually been handed to libvlc, otherwise a
        // slow gateway would be counted against the camera.
        _ = FetchAndPlayAsync(_urlProvider, attempt.Token);
    }

    private async Task FetchAndPlayAsync(
        Func<CancellationToken, Task<string?>> provider,
        CancellationToken ct)
    {
        string? url;
        try
        {
            url = await provider(ct).ConfigureAwait(true);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested || _disposed)
        {
            return;
        }
        catch (OperationCanceledException)
        {
            OnFailure(Strings.T("video.gatewayTimeout"));
            return;
        }
        catch (Exception ex)
        {
            if (!ct.IsCancellationRequested && !_disposed)
                OnFailure(Strings.T(ex is HttpRequestException ? "video.gatewayUnreachable" : "video.urlFailed"));
            return;
        }

        if (ct.IsCancellationRequested || _disposed)
        {
            return;
        }

        if (string.IsNullOrEmpty(url))
        {
            OnFailure(Strings.T("video.noUrl"));
            return;
        }

        try
        {
            using var media = new Media(_libVlc, new Uri(url));
            // Set per input as well as globally: libvlc resolves these per media, and an RTSP
            // source that silently falls back to UDP is where jitter comes from.
            media.AddOption(":rtsp-tcp");
            media.AddOption(":network-caching=500");
            media.AddOption(":live-caching=500");
            // Cameras without sound keep the picture-only path: no audio decoder, no audio device.
            if (!AudioAvailable) media.AddOption(":no-audio");
            _player.Mute = _muted;
            _player.Play(media);
        }
        catch (Exception ex) when (ex is VLCException or UriFormatException)
        {
            OnFailure(Strings.T("video.openFailed"));
            return;
        }

        // Point 3: the error event alone is not enough to notice a stream that never arrives.
        _watchdog.Stop();
        _watchdog.Start();
    }

    private void CancelAttempt()
    {
        _attempt?.Cancel();
        _attempt?.Dispose();
        _attempt = null;
    }

    private void OnPlaying()
    {
        _watchdog.Stop();
        if (_disposed || _urlProvider is null) return;
        // ได้ frame จริงจึงคืน retry budget ใน Poll — Playing อย่างเดียวอาจเป็นเสียงหรือภาพค้าง
        _framelessSeconds = 0;
        _player.Mute = _muted;
        SetState(VideoState.Playing, null);
    }

    private void OnFailure(string reason)
    {
        _watchdog.Stop();

        if (_disposed || _urlProvider is null)
        {
            return;
        }

        if (_retryCount >= MaxRetries)
        {
            SetState(VideoState.Failed, Strings.T("video.unavailable"));
            return;
        }

        _retryCount++;
        Reconnects++;
        LastFailure = reason;
        var failedAttempt = _attempt;
        SetState(VideoState.Retrying, string.Format(Strings.T("video.retrying"), reason, _retryCount, MaxRetries));
        // StateChanged อาจสั่ง fallback/stop ทันที; ห้าม timer ของงานเก่าแทรกงานใหม่
        if (_disposed || State != VideoState.Retrying || !ReferenceEquals(failedAttempt, _attempt)) return;
        _retryTimer.Stop();
        _retryTimer.Start();
    }

    private void SetState(VideoState state, string? message)
    {
        State = state;
        StateChanged?.Invoke(this, new VideoStateChangedEventArgs(state, message));
    }

    /// <summary>
    /// libvlc raises its events on its own threads. Everything in this class touches
    /// DispatcherTimers and drives UI state, so every callback has to land on the UI thread.
    /// </summary>
    private static void Dispatch(Action action)
    {
        var dispatcher = System.Windows.Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess())
        {
            action();
        }
        else
        {
            dispatcher.BeginInvoke(action);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _retryTimer.Stop();
        _watchdog.Stop();
        CancelAttempt();

        try
        {
            _player.Stop();
            _player.Dispose();
        }
        catch (Exception ex) when (ex is VLCException or ObjectDisposedException)
        {
            // Disposal races with libvlc's own teardown; nothing useful to do about it here.
        }
    }
}
