using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SurveillanceGateway.Client.Models;

namespace SurveillanceGateway.Client.Services;

public sealed record StreamDiagnostic(string CameraId, string? GlobalId, string Stream,
    string State, double Fps, long LostPictures, int Reconnects, uint Width, uint Height,
    string? Codec, bool HardwareDecodingRequested, string Decoder, bool Fallback, string? LastError);

public static class ClientDiagnostics
{
    // ส่งออกเฉพาะคอลัมน์ที่ปลอดภัย ไม่รับ URL/token/key หรือ log ดิบจาก renderer
    public static string Serialize(IEnumerable<StreamDiagnostic> streams)
    {
        using var process = Process.GetCurrentProcess();
        return JsonSerializer.Serialize(new {
            schemaVersion = 1, version = typeof(ClientDiagnostics).Assembly.GetName().Version?.ToString(),
            capturedAt = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(7)),
            workingSetBytes = process.WorkingSet64, processCpuSeconds = process.TotalProcessorTime.TotalSeconds,
            logicalProcessors = Environment.ProcessorCount, streams = streams.ToArray()
        }, new JsonSerializerOptions { WriteIndented = true });
    }

    // อ่านไฟล์ที่ดาวน์โหลดสำเร็จแล้วเพื่อสร้าง manifest โดยไม่แก้เนื้อหาวิดีโอ
    public static async Task WriteEvidenceAsync(string video, V1Camera camera, DateTimeOffset start,
        int durationSeconds, CancellationToken ct)
    {
        var target = video + ".evidence.json";
        // ห้ามเหลือ manifest เก่าหลังไฟล์วิดีโอถูกเขียนทับ
        if(File.Exists(target)) File.Delete(target);
        await using var input = new FileStream(video, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
        var hash = Convert.ToHexString(await System.Security.Cryptography.SHA256.HashDataAsync(input, ct)).ToLowerInvariant();
        var text = JsonSerializer.Serialize(new {
            schemaVersion = 1, file = Path.GetFileName(video), sha256 = hash, bytes = input.Length,
            cameraId = camera.Id, globalId = camera.GlobalId, cameraName = camera.DisplayName,
            requestedStart = start.ToOffset(TimeSpan.FromHours(7)), requestedEnd = start.AddSeconds(durationSeconds).ToOffset(TimeSpan.FromHours(7)),
            exportedAt = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(7)),
            clientVersion = typeof(ClientDiagnostics).Assembly.GetName().Version?.ToString()
        }, new JsonSerializerOptions { WriteIndented = true });
        var partial = target + "." + Guid.NewGuid().ToString("N") + ".part";
        try { await File.WriteAllTextAsync(partial, text, ct); File.Move(partial, target, true); }
        finally { if (File.Exists(partial)) File.Delete(partial); }
    }
}

public static class WallStreamPolicy
{
    // Auto ใช้ภาพย่อยสำหรับหลายช่องและภาพหลักเมื่อขยาย; main/sub ที่เลือกเองคงเดิม
    public static string Resolve(string preference, bool focused, int cells) =>
        preference == "auto" ? (focused || cells == 1 ? "main" : "sub") : preference == "main" ? "main" : "sub";
}
