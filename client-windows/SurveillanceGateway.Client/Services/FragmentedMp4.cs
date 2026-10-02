using System;
using System.Buffers.Binary;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SurveillanceGateway.Client.Services;

internal static class FragmentedMp4
{
    /// <summary>ตรวจขอบเขต box และ fragment ของ fMP4 หลังรับครบ โดยไม่โหลดวิดีโอทั้งไฟล์เข้า RAM</summary>
    internal static async Task ValidateAsync(string path, CancellationToken ct)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, true);
        var header = new byte[16];
        var length = file.Length;
        bool ftyp = false, moov = false, fragmentPending = false, media = false;
        while (file.Position < length)
        {
            ct.ThrowIfCancellationRequested();
            var offset = file.Position;
            if (length - offset < 8) throw Invalid();
            await file.ReadExactlyAsync(header.AsMemory(0, 8), ct).ConfigureAwait(false);
            ulong size = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(0, 4));
            var type = Encoding.ASCII.GetString(header, 4, 4);
            var headerSize = 8;
            if (size == 1)
            {
                if (length - offset < 16) throw Invalid();
                await file.ReadExactlyAsync(header.AsMemory(8, 8), ct).ConfigureAwait(false);
                size = BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8, 8));
                headerSize = 16;
            }
            else if (size == 0) size = (ulong)(length - offset);
            if (size < (ulong)headerSize || size > (ulong)(length - offset)) throw Invalid();
            if (offset == 0 && type != "ftyp") throw Invalid();
            switch (type)
            {
                case "ftyp":
                    if (ftyp || offset != 0 || size < (ulong)headerSize + 8) throw Invalid();
                    ftyp = true;
                    break;
                case "moov":
                    if (!ftyp || moov || media || fragmentPending || size <= (ulong)headerSize) throw Invalid();
                    moov = true;
                    break;
                case "moof":
                    if (!moov || fragmentPending || size <= (ulong)headerSize) throw Invalid();
                    fragmentPending = true;
                    break;
                case "mdat":
                    if (!fragmentPending || size <= (ulong)headerSize) throw Invalid();
                    fragmentPending = false;
                    media = true;
                    break;
            }
            file.Position = offset + (long)size;
        }
        if (!ftyp || !moov || !media || fragmentPending) throw Invalid();
    }

    private static InvalidDataException Invalid() => new(Strings.T("playback.downloadInvalid"));
}
