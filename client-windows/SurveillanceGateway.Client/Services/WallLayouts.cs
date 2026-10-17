using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Services;

/// <summary>ช่องหนึ่งช่องในผัง: ตำแหน่งบนกริดและจำนวนแถว/คอลัมน์ที่ช่องนี้กินพื้นที่</summary>
public readonly record struct WallCellRect(int Row, int Column, int RowSpan, int ColumnSpan);

/// <summary>
/// ผังของ video wall หนึ่งแบบ: กริด Rows × Columns ที่รวมช่องเป็นช่องใหญ่ได้
///
/// ลำดับช่องเรียงตามมุมบนซ้ายแบบ row-major จึงทำให้ช่องใหญ่ที่อยู่บนซ้ายเป็นช่องแรกเสมอ
/// และการแบ่งหน้า/บันทึกวิวที่อิงลำดับช่องยังใช้ได้เหมือนผังช่องเท่ากัน
/// </summary>
public sealed class WallLayoutDefinition
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("rows")]
    public int Rows { get; set; }

    [JsonPropertyName("columns")]
    public int Columns { get; set; }

    /// <summary>แต่ละช่องเป็น [row, column, rowSpan, columnSpan]</summary>
    [JsonPropertyName("cells")]
    public int[][] Cells { get; set; } = Array.Empty<int[]>();

    [JsonIgnore]
    public bool IsBuiltIn { get; init; }

    [JsonIgnore]
    public IReadOnlyList<WallCellRect> Rects =>
        Cells.Select(c => new WallCellRect(c[0], c[1], c[2], c[3])).ToArray();

    [JsonIgnore]
    public int CellCount => Cells.Length;

    /// <summary>ผังที่ทุกช่องเท่ากัน (ผังเดิม 1/4/9/16/25)</summary>
    [JsonIgnore]
    public bool IsUniform => Cells.All(c => c[2] == 1 && c[3] == 1);

    /// <summary>ชื่อที่ dropdown แสดง</summary>
    public override string ToString() => IsBuiltIn ? Strings.T("layout.preset", Name, CellCount) : Strings.T("layout.custom", Name, CellCount);
}

/// <summary>
/// ผังสำเร็จรูปและการตรวจผังที่ผู้ใช้สร้าง
///
/// แบบช่องไม่เท่ากันยืมจาก VMS ที่ศูนย์ใช้อยู่ (1+5, 1+7, 2+8, 1+12) จำกัดไม่เกิน 25 ช่อง
/// เท่าผังใหญ่สุดเดิม เพื่อไม่ให้เครื่อง client ต้องถอดรหัสมากกว่าที่เคยทดสอบไว้
/// </summary>
public static class WallLayouts
{
    public const int MaxCells = 25;
    public const int MinSide = 1;
    public const int MaxSide = 6;

    public static readonly IReadOnlyList<WallLayoutDefinition> Uniform =
        new[] { 1, 4, 9, 16, 25 }.Select(n => UniformLayout(n)).ToArray();

    public static readonly IReadOnlyList<WallLayoutDefinition> Mixed = new[]
    {
        Build("1+5", "1+5", 3, 3, new[] { new[] { 0, 0, 2, 2 } })!,
        Build("1+7", "1+7", 4, 4, new[] { new[] { 0, 0, 3, 3 } })!,
        Build("2+8", "2+8", 4, 4, new[] { new[] { 0, 0, 2, 2 }, new[] { 0, 2, 2, 2 } })!,
        Build("1+12", "1+12", 4, 4, new[] { new[] { 1, 1, 2, 2 } })!,
        Build("1+9", "1+9", 5, 5, new[] { new[] { 0, 0, 4, 4 } })!,
        Build("1+3", "1+3", 3, 4, new[] { new[] { 0, 0, 3, 3 } })!,
    };

    /// <summary>หา id ของผังเท่ากันตามจำนวนช่อง ใช้กับค่าที่บันทึกไว้ก่อนมีผังแบบรวมช่อง</summary>
    public static string UniformId(int cells) => Math.Clamp(cells, 1, MaxCells).ToString();

    /// <summary>หาผังจาก id: ผังสำเร็จรูปก่อน แล้วผังของผู้ใช้; ไม่เจอ = ผังเท่ากันตามจำนวนช่องสำรอง</summary>
    public static WallLayoutDefinition Resolve(string? id, IEnumerable<WallLayoutDefinition>? custom, int fallbackCells)
    {
        if (!string.IsNullOrEmpty(id))
        {
            var found = Uniform.Concat(Mixed).FirstOrDefault(l => l.Id == id)
                ?? custom?.FirstOrDefault(l => l.Id == id && IsValid(l));
            if (found is not null) return found;
        }

        return Uniform.FirstOrDefault(l => l.CellCount == fallbackCells) ?? UniformLayout(fallbackCells);
    }

    /// <summary>
    /// สร้างผังจากกริดและช่องรวม: ทุกตารางที่ไม่ได้อยู่ในช่องรวมกลายเป็นช่องเดี่ยว 1×1
    /// คืน null เมื่อช่องรวมซ้อนกัน หลุดกริด หรือจำนวนช่องเกิน <see cref="MaxCells"/>
    /// </summary>
    public static WallLayoutDefinition? Build(string id, string name, int rows, int columns, IEnumerable<int[]> merged, bool builtIn = true)
    {
        if (rows < MinSide || rows > MaxSide || columns < MinSide || columns > MaxSide) return null;
        var owner = new bool[rows, columns];
        var cells = new List<int[]>();
        foreach (var m in merged)
        {
            if (m.Length != 4 || m[2] < 1 || m[3] < 1 || m[0] < 0 || m[1] < 0 || m[0] + m[2] > rows || m[1] + m[3] > columns) return null;
            for (var r = m[0]; r < m[0] + m[2]; r++)
            for (var c = m[1]; c < m[1] + m[3]; c++)
            {
                if (owner[r, c]) return null;
                owner[r, c] = true;
            }
            cells.Add(new[] { m[0], m[1], m[2], m[3] });
        }

        for (var r = 0; r < rows; r++)
        for (var c = 0; c < columns; c++)
        {
            if (!owner[r, c]) cells.Add(new[] { r, c, 1, 1 });
        }

        if (cells.Count == 0 || cells.Count > MaxCells) return null;
        return new WallLayoutDefinition
        {
            Id = id,
            Name = name,
            Rows = rows,
            Columns = columns,
            Cells = cells.OrderBy(c => c[0]).ThenBy(c => c[1]).ToArray(),
            IsBuiltIn = builtIn,
        };
    }

    /// <summary>ตรวจผังที่อ่านจากไฟล์ตั้งค่า: ช่องต้องปูเต็มกริดพอดีไม่ซ้อนกัน</summary>
    public static bool IsValid(WallLayoutDefinition layout)
    {
        if (layout.Cells is null || layout.Cells.Any(c => c is null || c.Length != 4)) return false;
        var rebuilt = Build(layout.Id, layout.Name, layout.Rows, layout.Columns, layout.Cells.Where(c => c[2] > 1 || c[3] > 1), builtIn: false);
        return rebuilt is not null && rebuilt.CellCount == layout.CellCount;
    }

    /// <summary>คืนผังที่เรียงช่องใหม่และตรวจแล้ว สำหรับบันทึกผังที่ผู้ใช้แก้</summary>
    public static WallLayoutDefinition? Normalise(WallLayoutDefinition layout) =>
        IsValid(layout) ? Build(layout.Id, layout.Name, layout.Rows, layout.Columns, layout.Cells.Where(c => c[2] > 1 || c[3] > 1), builtIn: false) : null;

    private static WallLayoutDefinition UniformLayout(int cells)
    {
        var side = (int)Math.Ceiling(Math.Sqrt(Math.Clamp(cells, 1, MaxCells)));
        return Build(UniformId(side * side), (side * side).ToString(), side, side, Array.Empty<int[]>())!;
    }
}
