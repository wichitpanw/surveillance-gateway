using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace SurveillanceGateway.Client.Services;

public sealed partial class GatewayClient
{
    private static readonly SemaphoreSlim DownloadSlot = new(1, 1);

    /// <summary>ดาวน์โหลด MP4 หนึ่งงานต่อโปรแกรม เขียนไฟล์ชั่วคราวและย้ายเมื่อรับครบเท่านั้น</summary>
    public async Task DownloadPlaybackAsync(string cameraId, DateTimeOffset start, int durationSeconds,
        string destination, IProgress<long>? progress, CancellationToken ct)
    {
        if (durationSeconds < 1 || durationSeconds > 1800)
            throw new ArgumentException(Strings.T("playback.downloadLimit"));
        if (!await DownloadSlot.WaitAsync(0, ct).ConfigureAwait(false))
            throw new InvalidOperationException(Strings.T("playback.downloadBusy"));
        var partial = destination + "." + Guid.NewGuid().ToString("N") + ".part";
        try
        {
            using var http = new HttpClient { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
            var query = $"?start={Uri.EscapeDataString(start.ToString("o"))}&duration={durationSeconds}";
            using var req = KeyedRequest(HttpMethod.Get,
                $"/api/v1/cameras/{Uri.EscapeDataString(cameraId)}/download.mp4{query}");
            using var headersTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            headersTimeout.CancelAfter(TimeSpan.FromSeconds(90));
            using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, headersTimeout.Token).ConfigureAwait(false);
            ThrowIfUnauthorized(res);
            if (!res.IsSuccessStatusCode)
            {
                var error = await res.Content.ReadAsStringAsync(headersTimeout.Token).ConfigureAwait(false);
                string? message = null;
                try { using var json = JsonDocument.Parse(error); message = json.RootElement.GetProperty("error").GetString(); }
                catch (JsonException) { }
                catch (KeyNotFoundException) { }
                throw new HttpRequestException(message ?? string.Format(Strings.T("playback.downloadHttpError"), (int)res.StatusCode));
            }
            if (res.Content.Headers.ContentType?.MediaType != "video/mp4")
                throw new InvalidDataException(Strings.T("playback.downloadInvalid"));
            await using var input = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var prefix = new byte[12];
            using (var firstTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                firstTimeout.CancelAfter(TimeSpan.FromSeconds(90));
                await input.ReadExactlyAsync(prefix, firstTimeout.Token).ConfigureAwait(false);
            }
            if (Encoding.ASCII.GetString(prefix, 4, 4) != "ftyp")
                throw new InvalidDataException(Strings.T("playback.downloadInvalid"));
            long bytes = prefix.Length;
            await using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
            {
                await output.WriteAsync(prefix, ct).ConfigureAwait(false);
                var buffer = new byte[65536];
                var clock = Stopwatch.StartNew();
                while (true)
                {
                    using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    readTimeout.CancelAfter(TimeSpan.FromSeconds(90));
                    var read = await input.ReadAsync(buffer, readTimeout.Token).ConfigureAwait(false);
                    if (read == 0) break;
                    await output.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    bytes += read;
                    if (clock.ElapsedMilliseconds >= 250) { progress?.Report(bytes); clock.Restart(); }
                }
                await output.FlushAsync(ct).ConfigureAwait(false);
            }
            ct.ThrowIfCancellationRequested();
            if (bytes <= prefix.Length) throw new InvalidDataException(Strings.T("playback.downloadInvalid"));
            await FragmentedMp4.ValidateAsync(partial, ct).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            File.Move(partial, destination, true);
            progress?.Report(bytes);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException(Strings.T("playback.downloadTimeout"));
        }
        finally
        {
            try { if (File.Exists(partial)) File.Delete(partial); }
            finally { DownloadSlot.Release(); }
        }
    }
}
