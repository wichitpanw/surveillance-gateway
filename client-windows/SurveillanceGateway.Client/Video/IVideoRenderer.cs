using System;
using System.Threading;
using System.Threading.Tasks;

namespace SurveillanceGateway.Client.Video;

public enum VideoState
{
    Idle,
    Connecting,
    Playing,
    Retrying,
    Failed,
}

public sealed class VideoStateChangedEventArgs : EventArgs
{
    public VideoStateChangedEventArgs(VideoState state, string? message)
    {
        State = state;
        Message = message;
    }

    public VideoState State { get; }

    /// <summary>Text fit to show in the tile overlay - never a raw exception dump.</summary>
    public string? Message { get; }
}

/// <summary>
/// One video surface, and the reconnect policy around it.
///
/// The interface exists so the player can be swapped without touching any view. libmpv is the
/// live alternative to LibVLC here - smaller payload, better documented low-latency options -
/// and keeping every view behind this contract means trying it costs one class rather than a
/// rewrite.
/// </summary>
public interface IVideoRenderer : IDisposable
{
    VideoState State { get; }

    /// <summary>Frames the vout has actually displayed since the last poll, per second.</summary>
    double Fps { get; }

    long LostPictures { get; }

    /// <summary>
    /// Whether the camera sends sound (set at the edge). False keeps the old picture-only path -
    /// no audio track is decoded and no audio output is opened. Takes effect on the next Play.
    /// </summary>
    bool AudioAvailable { get; set; }

    /// <summary>Starts true for every cell: a wall must never start talking on its own.</summary>
    bool Muted { get; set; }

    event EventHandler<VideoStateChangedEventArgs>? StateChanged;

    /// <summary>
    /// Starts (or restarts) playback.
    ///
    /// The URL arrives through a provider rather than as a string because the gateway's mp4 URLs
    /// carry a stream token that expires in about five minutes and is checked when the connection
    /// opens. Replaying a URL captured at first play would fail on any later reconnect, and the
    /// failure would look exactly like a dead camera. Every attempt asks for a fresh one.
    ///
    /// <paramref name="ownerKey"/> identifies what is being played - camera plus stream type.
    /// The retry budget resets when it changes; see the implementation for why that matters.
    /// </summary>
    void Play(Func<CancellationToken, Task<string?>> urlProvider, string ownerKey);

    void Stop();

    /// <summary>Samples the player's counters. Called on a timer by whatever owns the tile.</summary>
    void Poll(double elapsedSeconds);
}
