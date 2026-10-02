using System;
using System.Windows.Controls;
using LibVLCSharp.Shared;
using VlcMediaPlayer = LibVLCSharp.Shared.MediaPlayer;

namespace SurveillanceGateway.VideoWallProbe;

/// <summary>
/// One tile of the wall: a player, its caption overlay, and the counters needed to tell a
/// smooth stream from one that is merely connected.
/// </summary>
internal sealed class Cell : IDisposable
{
    private readonly LibVLC _libVlc;
    private readonly TextBlock _caption;

    private long _lastDisplayed;
    private bool _disposed;

    public Cell(int index, string? url, VlcMediaPlayer? player, TextBlock caption, LibVLC libVlc)
    {
        Index = index;
        Url = url;
        Player = player;
        _caption = caption;
        _libVlc = libVlc;
    }

    public int Index { get; }

    public string? Url { get; }

    public VlcMediaPlayer? Player { get; }

    public void Start()
    {
        if (Player is null || Url is null)
        {
            return;
        }

        using var media = new Media(_libVlc, new Uri(Url));
        // Per-media transport and caching. Set here as well as globally because libvlc resolves
        // these per input, and an RTSP source that falls back to UDP is where jitter comes from.
        media.AddOption(":rtsp-tcp");
        media.AddOption(":network-caching=200");
        media.AddOption(":live-caching=200");
        Player.Play(media);
    }

    public Snapshot Sample(double wallSeconds)
    {
        if (Player is null)
        {
            _caption.Text = $"{Index + 1}: (no stream)";
            return new Snapshot("none", 0, 0, 0, 0, false);
        }

        var state = Player.State.ToString().ToLowerInvariant();
        long decoded = 0;
        long displayed = 0;
        long lost = 0;

        var media = Player.Media;
        if (media is not null)
        {
            var stats = media.Statistics;
            decoded = stats.DecodedVideo;
            displayed = stats.DisplayedPictures;
            lost = stats.LostPictures;
        }

        var delta = displayed - _lastDisplayed;
        // A restarted stream resets libvlc's counters; a negative delta is that, not a stall.
        var fps = wallSeconds > 0 && delta >= 0 ? delta / wallSeconds : 0;
        _lastDisplayed = displayed;

        var isPlaying = Player.IsPlaying;
        _caption.Text = isPlaying
            ? $"{Index + 1}: {fps:F0} fps  lost {lost}"
            : $"{Index + 1}: {state}";

        return new Snapshot(state, decoded, displayed, lost, fps, isPlaying);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        if (Player is not null)
        {
            Player.Stop();
            Player.Dispose();
        }
    }

    internal readonly record struct Snapshot(
        string State,
        long Decoded,
        long Displayed,
        long Lost,
        double Fps,
        bool IsPlaying);
}
