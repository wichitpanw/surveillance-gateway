using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Services;

/// <summary>
/// One saved gateway: an address and the API key for it.
///
/// Kept as a list rather than a single slot because a machine is often pointed at more than one
/// gateway over its life - a test one, then the real one - and because losing the key is the
/// expensive failure here. Switching gateways must not overwrite the key for the old one.
/// </summary>
public sealed class KeyProfile
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("n");

    /// <summary>What the operator calls this gateway. Free text; the key hint identifies it exactly.</summary>
    [JsonPropertyName("label")]
    public string Label { get; set; } = string.Empty;

    [JsonPropertyName("serverUrl")]
    public string ServerUrl { get; set; } = string.Empty;

    /// <summary>DPAPI-protected API key, base64. Never the key itself.</summary>
    [JsonPropertyName("protectedApiKey")]
    public string ProtectedApiKey { get; set; } = string.Empty;

    /// <summary>Name the gateway reported for this key, filled in after a successful check.</summary>
    [JsonPropertyName("clientName")]
    public string? ClientName { get; set; }

    [JsonPropertyName("lastUsedAt")]
    public string? LastUsedAt { get; set; }
}

/// <summary>
/// A named wall arrangement: how many cells, which camera is in each, and on which stream.
///
/// Saved on this machine rather than at Central, because a view is about one screen in one room -
/// the same key on a guard desk and on a lobby display wants different arrangements, and a
/// server-side list would make one of them wrong.
/// </summary>
public sealed class WallView
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("n");

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("cells")]
    public int Cells { get; set; } = 9;

    /// <summary>id ของผัง (ช่องเท่ากันหรือรวมช่อง); วิวรุ่นก่อนไม่มีค่านี้ จึงใช้ <see cref="Cells"/> แทน</summary>
    [JsonPropertyName("layout")]
    public string? Layout { get; set; }
    public string? Mode { get; set; }

    /// <summary>Camera ids in cell order. Empty entries are empty cells, and are kept.</summary>
    [JsonPropertyName("cameras")]
    public string[] Cameras { get; set; } = Array.Empty<string>();

    /// <summary>"sub" or "main" per cell. Shorter than <see cref="Cameras"/> means "sub".</summary>
    [JsonPropertyName("streams")]
    public string[] Streams { get; set; } = Array.Empty<string>();

    /// <summary>The view picker's template shows the selected item as text, so this is its label.</summary>
    public override string ToString() => Name;
}

/// <summary>
/// Per-machine client settings.
///
/// Shape follows demo-client/src/lib/profiles.js, which already solved "user-configurable base
/// URL, validated by a health call, remembered between runs" for the app this one replaces.
///
/// Keys are protected with DPAPI at CurrentUser scope, so the file is useless on another machine
/// or under another Windows account. That is real but limited: anything running as this user can
/// still unprotect it. The key's own protection is that it is revocable from the gateway.
/// </summary>
public sealed class AppSettings
{
    public string WorkspaceDensity { get; set; } = "compact";
    private const string EntropyLabel = "SurveillanceGateway.Client/credentials/v1";

    /// <summary>UTF-8 with no byte order mark: the file is JSON other tools read too.</summary>
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>
    /// Identifies this installation to the gateway, so Central can count how many clients are
    /// actually running on one key.
    ///
    /// Generated once and kept. A value that changed per launch would make one machine look like
    /// a crowd, which is precisely the number an administrator would be reading before deciding
    /// whether a key is safe to revoke.
    /// </summary>
    [JsonPropertyName("instanceId")]
    public string InstanceId { get; set; } = Guid.NewGuid().ToString("n");

    [JsonPropertyName("profiles")]
    public List<KeyProfile> Profiles { get; set; } = new();

    [JsonPropertyName("activeProfileId")]
    public string? ActiveProfileId { get; set; }

    [JsonPropertyName("theme")]
    public string Theme { get; set; } = "dark";

    /// <summary>
    /// "en" or "th". English by default.
    ///
    /// A machine handed to someone who does not read Thai has to be usable before anyone opens
    /// the settings dialog, and picking Thai is one click for those who want it.
    /// </summary>
    [JsonPropertyName("language")]
    public string Language { get; set; } = "en";

    /*
      The wall's arrangement is deliberately not stored.

      Cell ids, per-cell streams and the page number used to live here, and the wall restored
      them on open - which meant opening a tab started video nobody had asked for. Only the two
      preferences below survive a restart; an arrangement worth keeping is saved as a named view.
    */

    [JsonPropertyName("wallCells")]
    public int WallCells { get; set; } = 9;

    /// <summary>id ของผังล่าสุด; ว่าง = ผังเท่ากันตาม <see cref="WallCells"/> (ไฟล์ตั้งค่ารุ่นก่อน)</summary>
    [JsonPropertyName("wallLayout")]
    public string? WallLayout { get; set; }

    /// <summary>ผังรวมช่องที่ผู้ใช้สร้างเองในเครื่องนี้</summary>
    [JsonPropertyName("wallLayouts")]
    public List<WallLayoutDefinition> WallLayouts { get; set; } = new();

    /// <summary>
    /// The stream the whole wall is set to, and the one a newly placed camera starts on.
    ///
    /// Per-cell choices still exist and still win for that cell; this is what the wall-wide
    /// switch sets and what a fresh cell inherits, so filling a wall does not mean promoting
    /// twenty-five cells one at a time.
    /// </summary>
    [JsonPropertyName("wallStreamMode")]
    public string WallStreamMode { get; set; } = "sub";

    /// <summary>Saved wall arrangements the operator can switch between.</summary>
    [JsonPropertyName("wallViews")]
    public List<WallView> WallViews { get; set; } = new();

    public bool RestoreMonitorWalls { get; set; }
    public List<MonitorWallPlacement> MonitorWalls { get; set; } = new();

    [JsonPropertyName("favoriteCameraIds")]
    public List<string> FavoriteCameraIds { get; set; } = new();

    [JsonPropertyName("wallCycleSeconds")]
    public int WallCycleSeconds { get; set; } = 15;

    /*
      Fields from the single-key layout this file used before profiles existed.

      Kept only so Migrate() can carry an existing key forward. Dropping them would mean every
      machine already in the field silently loses the key it holds on the next upgrade - the
      exact failure the profile list is meant to prevent, delivered by the code meant to prevent it.
    */

    [JsonPropertyName("serverUrl")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LegacyServerUrl { get; set; }

    [JsonPropertyName("protectedApiKey")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LegacyProtectedApiKey { get; set; }

    /// <summary>
    /// Where settings live: `%LOCALAPPDATA%\SurveillanceGateway.Client\settings.json`.
    ///
    /// Deliberately not `%LOCALAPPDATA%\SurveillanceGateway`, which is the installer's own directory - it
    /// holds `current`, `packages` and `Update.exe`, and uninstalling deletes all of it. Settings
    /// kept in there would be destroyed by an uninstall the operator meant as "remove the app, I
    /// will reinstall it", taking the API key with them.
    /// </summary>
    [JsonIgnore]
    public static string FilePath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SurveillanceGateway.Client",
        "settings.json");

    /// <summary>The pre-1.0.3 location, inside the installer's directory. Read once, then moved.</summary>
    private static string LegacyFilePath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SurveillanceGateway",
        "settings.json");

    [JsonIgnore]
    public KeyProfile? Active =>
        Profiles.FirstOrDefault(p => p.Id == ActiveProfileId) ?? Profiles.FirstOrDefault();

    public static AppSettings Load()
    {
        try
        {
            MigrateFromLegacyPath();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The legacy copy is best effort; the files below are what counts.
        }

        // The main file first, then the copy Save() keeps - a write cut short by a crash or a power
        // cut leaves the main file truncated, and the .bak is the only other record of the key.
        var loaded = TryRead(FilePath) ?? TryRead(FilePath + ".bak");
        if (loaded is not null)
        {
            loaded.Migrate();
            return loaded;
        }

        // A corrupt or unreadable settings file must not stop the client from starting: the
        // connect screen can always take the address and key again.
        return new AppSettings();
    }

    /// <summary>Reads one settings file, or null when it is missing, unreadable or not valid JSON.</summary>
    private static AppSettings? TryRead(string path)
    {
        try
        {
            return File.Exists(path)
                ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path, Encoding.UTF8))
                : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Moves settings out of the installer's directory, once.
    ///
    /// Builds up to 1.0.2 wrote into `%LOCALAPPDATA%\SurveillanceGateway`, which the installer owns and
    /// deletes on uninstall. Copying rather than moving would leave a second file that a later
    /// version could pick up after the key had been changed here, so the old one is removed - but
    /// only after the new one is written, because the file being copied is the only record of the
    /// API key on this machine.
    ///
    /// DPAPI is not involved: the protected blob is bound to the user, not to the path, so it
    /// still unprotects from the new location.
    /// </summary>
    private static void MigrateFromLegacyPath()
    {
        if (File.Exists(FilePath) || !File.Exists(LegacyFilePath))
        {
            return;
        }

        var dir = Path.GetDirectoryName(FilePath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        File.Copy(LegacyFilePath, FilePath, overwrite: false);

        try
        {
            File.Delete(LegacyFilePath);
            File.Delete(LegacyFilePath + ".bak");
        }
        catch (IOException)
        {
            // Leaving the old file behind is harmless - it is never read again once the new one
            // exists - and failing the migration over it would be worse.
        }
    }

    /// <summary>
    /// Writes the file, keeping the previous one as `.bak`.
    ///
    /// The backup exists because this file is the only copy of a key on this machine, and a
    /// truncated write during a crash or a power cut would lose it. Copy-then-write is cheap
    /// insurance against the one failure that costs an operator a trip to every client machine.
    /// </summary>
    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(FilePath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            // Only a file that still reads back becomes the backup. After a truncated write the
            // main file is garbage and the .bak is the good copy Load() fell back to - copying
            // over it would destroy the last record of the key.
            if (TryRead(FilePath) is not null)
            {
                File.Copy(FilePath, FilePath + ".bak", overwrite: true);
            }

            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(FilePath, json, Utf8NoBom);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Losing a preference is not worth taking the app down for.
        }
    }

    /// <summary>
    /// Carries a key written by the pre-profile layout into the profile list.
    ///
    /// The protected blob is moved across as-is: DPAPI is bound to the Windows account, not to
    /// the field it was stored in, so it unprotects exactly as before. Re-encrypting it would
    /// mean holding the plaintext key in memory for no gain.
    ///
    /// Runs on every load and is idempotent - once a profile exists for that address, the legacy
    /// fields are cleared and the next Save() drops them from the file.
    /// </summary>
    private void Migrate()
    {
        MonitorWalls ??= new();
        MonitorWalls = MonitorWalls.Where(p => p is not null && !string.IsNullOrEmpty(p.ViewId)).ToList();
        WallLayouts = (WallLayouts ?? new()).Where(l => l is not null && !string.IsNullOrEmpty(l.Id))
            .Select(Services.WallLayouts.Normalise).OfType<WallLayoutDefinition>().ToList();
        if (string.IsNullOrEmpty(LegacyProtectedApiKey) || string.IsNullOrEmpty(LegacyServerUrl))
        {
            LegacyServerUrl = null;
            LegacyProtectedApiKey = null;
            return;
        }

        var already = Profiles.Any(p =>
            string.Equals(p.ServerUrl, LegacyServerUrl, StringComparison.OrdinalIgnoreCase));

        if (!already)
        {
            var carried = new KeyProfile
            {
                ServerUrl = LegacyServerUrl!,
                ProtectedApiKey = LegacyProtectedApiKey!,
            };
            Profiles.Add(carried);
            ActiveProfileId ??= carried.Id;
        }

        LegacyServerUrl = null;
        LegacyProtectedApiKey = null;
        Save();
    }

    /// <summary>Adds or updates the profile for one gateway, keyed by its address.</summary>
    public KeyProfile UpsertProfile(string serverUrl, string apiKey, string? label = null)
    {
        var existing = Profiles.FirstOrDefault(p =>
            string.Equals(p.ServerUrl, serverUrl, StringComparison.OrdinalIgnoreCase));

        if (existing is null)
        {
            existing = new KeyProfile { ServerUrl = serverUrl };
            Profiles.Add(existing);
        }

        existing.ServerUrl = serverUrl;
        existing.ProtectedApiKey = Protect(apiKey);
        existing.LastUsedAt = DateTimeOffset.Now.ToString("o");
        if (!string.IsNullOrWhiteSpace(label))
        {
            existing.Label = label!;
        }

        ActiveProfileId = existing.Id;
        return existing;
    }

    public string GetApiKey(KeyProfile? profile = null) => Unprotect((profile ?? Active)?.ProtectedApiKey);

    /// <summary>
    /// Same shape as `key_hint` in the api_clients table, so a key here can be matched by eye
    /// against the row on the gateway's API Clients page.
    /// </summary>
    public static string KeyHint(string key)
    {
        if (string.IsNullOrEmpty(key))
        {
            return Strings.T("connect.noKeyYet");
        }

        return key.Length < 16 ? "••••" : $"{key[..9]}…{key[^6..]}";
    }

    private static string Protect(string? secret)
    {
        if (string.IsNullOrEmpty(secret))
        {
            return string.Empty;
        }

        try
        {
            var cipher = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(secret),
                Encoding.UTF8.GetBytes(EntropyLabel),
                DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(cipher);
        }
        catch (CryptographicException)
        {
            // Better to forget a secret than to write it out unprotected.
            return string.Empty;
        }
    }

    private static string Unprotect(string? stored)
    {
        if (string.IsNullOrEmpty(stored))
        {
            return string.Empty;
        }

        try
        {
            var plain = ProtectedData.Unprotect(
                Convert.FromBase64String(stored),
                Encoding.UTF8.GetBytes(EntropyLabel),
                DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException)
        {
            // Copied from another machine or another account: unusable, so treat it as absent.
            return string.Empty;
        }
    }

    /// <summary>
    /// Normalises what a person types into a base URL. "203.0.113.80" and "203.0.113.80:5173"
    /// both have to work; nobody types a scheme.
    /// </summary>
    public static string NormaliseServerUrl(string input)
    {
        var typed = (input ?? string.Empty).Trim().TrimEnd('/');
        if (typed.Length == 0)
        {
            return string.Empty;
        }

        var value = typed.Contains("://", StringComparison.Ordinal) ? typed : "http://" + typed;

        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            return value;
        }

        // Whether a port was typed, judged on the authority alone - a path or query can carry a
        // colon of its own and must not be mistaken for one.
        var authority = value[(value.IndexOf("://", StringComparison.Ordinal) + 3)..];
        var slash = authority.IndexOf('/');
        if (slash >= 0)
        {
            authority = authority[..slash];
        }

        var builder = new UriBuilder(uri);
        if (!authority.Contains(':'))
        {
            // The gateway is fixed on 5173 and nothing else answers there, so an address with no
            // port means that port - not 80.
            builder.Port = 5173;
        }

        return builder.Uri.GetLeftPart(UriPartial.Authority);
    }
}
