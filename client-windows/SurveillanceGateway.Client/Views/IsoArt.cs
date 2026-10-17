using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// ภาพประกอบ isometric ของการ์ดหน้า Home วาดเป็น vector ทั้งหมด (ไม่มีไฟล์ภาพ)
///
/// พิกัด (x, y, z) ในหน่วย iso: x ไปขวาล่าง y ไปซ้ายล่าง z ขึ้นบน ผู้ชมมองจากฝั่ง +x +y +z
/// จึงเห็นด้านบน ด้าน +y (ซ้ายล่าง) และด้าน +x (ขวาล่าง) ผู้เรียกต้องวาดจากหลังไปหน้าเอง
/// (x + y น้อยก่อน) เพราะไม่มี z-buffer
/// </summary>
internal sealed class IsoScene
{
    private const double Cos30 = 0.8660254;
    private const double Unit = 20;
    private readonly Canvas _canvas = new();
    private readonly List<Point> _points = new();
    private readonly Color _ink;

    /// <param name="ink">สีหลักของภาพ (ปกติเป็นสีขาวอมฟ้า) ทุกผิวไล่ความสว่างจากสีนี้</param>
    public IsoScene(Color ink) => _ink = ink;

    private static Point P(double x, double y, double z) => new((x - y) * Cos30 * Unit, ((x + y) * 0.5 - z) * Unit);

    private static Color Shade(Color c, double factor, double alpha) =>
        Color.FromArgb((byte)Math.Clamp(alpha * 255, 0, 255),
            (byte)Math.Clamp(c.R * factor, 0, 255), (byte)Math.Clamp(c.G * factor, 0, 255), (byte)Math.Clamp(c.B * factor, 0, 255));

    private Brush Fill(double factor, double alpha) => Frozen(new SolidColorBrush(Shade(_ink, factor, alpha)));

    private static Brush Frozen(Brush b) { b.Freeze(); return b; }

    private void Poly(Brush fill, double edgeAlpha, params Point[] points)
    {
        _points.AddRange(points);
        _canvas.Children.Add(new Polygon
        {
            Points = new PointCollection(points),
            Fill = fill,
            Stroke = Fill(1, edgeAlpha),
            StrokeThickness = 0.8,
            StrokeLineJoin = PenLineJoin.Round,
        });
    }

    /// <summary>กล่องทึบ: ด้านบนสว่างสุด ด้านซ้ายกลาง ด้านขวามืดสุด</summary>
    public IsoScene Box(double x, double y, double z, double w, double d, double h, double alpha = 0.55)
    {
        Poly(Fill(0.62, alpha), 0.5, P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h));
        Poly(Fill(0.8, alpha), 0.5, P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h));
        Poly(Fill(1.0, Math.Min(1, alpha + 0.15)), 0.65, P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h));
        return this;
    }

    /// <summary>แผ่นบาง ๆ บนพื้น (ระนาบ z) เช่นพื้นห้องหรือแผนที่</summary>
    public IsoScene Plate(double x, double y, double z, double w, double d, double alpha = 0.18)
    {
        Poly(Fill(1, alpha), 0.45, P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z));
        return this;
    }

    /// <summary>สี่เหลี่ยมบนผิวที่หันไป +y (ผิวซ้ายล่าง) เช่นจอภาพ</summary>
    public IsoScene FaceY(double y, double x0, double x1, double z0, double z1, double factor = 0.5, double alpha = 0.6)
    {
        Poly(Fill(factor, alpha), 0.35, P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1));
        return this;
    }

    /// <summary>สี่เหลี่ยมบนผิวที่หันไป +x (ผิวขวาล่าง)</summary>
    public IsoScene FaceX(double x, double y0, double y1, double z0, double z1, double factor = 0.5, double alpha = 0.6)
    {
        Poly(Fill(factor, alpha), 0.35, P(x, y0, z0), P(x, y1, z0), P(x, y1, z1), P(x, y0, z1));
        return this;
    }

    /// <summary>เส้นตรงระหว่างสองจุดในพิกัด iso</summary>
    public IsoScene Line(double x0, double y0, double z0, double x1, double y1, double z1, double alpha = 0.75, double thickness = 1.1)
    {
        var a = P(x0, y0, z0); var b = P(x1, y1, z1);
        _points.Add(a); _points.Add(b);
        _canvas.Children.Add(new Line { X1 = a.X, Y1 = a.Y, X2 = b.X, Y2 = b.Y, Stroke = Fill(1, alpha), StrokeThickness = thickness, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round });
        return this;
    }

    /// <summary>วงรีบนพื้น (วงกลมในระนาบ z) เช่นคลื่นแจ้งเตือนหรือฐานหมุด</summary>
    public IsoScene Ring(double cx, double cy, double z, double r, double alpha = 0.6, bool filled = false)
    {
        var pts = Enumerable.Range(0, 36).Select(i => i * Math.PI * 2 / 36)
            .Select(t => P(cx + r * Math.Cos(t), cy + r * Math.Sin(t), z)).ToArray();
        _points.AddRange(pts);
        _canvas.Children.Add(new Polygon { Points = new PointCollection(pts), Fill = filled ? Fill(1, alpha * 0.4) : Brushes.Transparent, Stroke = Fill(1, alpha), StrokeThickness = 1 });
        return this;
    }

    /// <summary>รูปแบนหันหน้าเข้าหาผู้ชม (ไม่เอียงตาม iso) วางที่จุดในพิกัด iso เช่นหมุดหรือปุ่มเล่น</summary>
    public IsoScene Glyph(double x, double y, double z, string pathData, double size, double alpha = 0.95, Color? color = null)
    {
        var at = P(x, y, z);
        var geometry = Geometry.Parse(pathData);
        var path = new Path
        {
            Data = geometry,
            Fill = color is { } c ? Frozen(new SolidColorBrush(c)) : Fill(1, alpha),
            Stretch = Stretch.Uniform,
            Width = size,
            Height = size,
        };
        Canvas.SetLeft(path, at.X - size / 2);
        Canvas.SetTop(path, at.Y - size / 2);
        _points.Add(new Point(at.X - size / 2, at.Y - size / 2));
        _points.Add(new Point(at.X + size / 2, at.Y + size / 2));
        _canvas.Children.Add(path);
        return this;
    }

    /// <summary>ครอบภาพให้พอดีขอบเขตจริงแล้วย่อ/ขยายตามพื้นที่การ์ด</summary>
    public FrameworkElement Build()
    {
        const double pad = 4;
        var minX = _points.Min(p => p.X) - pad; var minY = _points.Min(p => p.Y) - pad;
        var maxX = _points.Max(p => p.X) + pad; var maxY = _points.Max(p => p.Y) + pad;
        _canvas.RenderTransform = new TranslateTransform(-minX, -minY);
        var host = new Canvas { Width = maxX - minX, Height = maxY - minY, ClipToBounds = false };
        host.Children.Add(_canvas);
        return new Viewbox { Child = host, Stretch = Stretch.Uniform, StretchDirection = StretchDirection.Both, IsHitTestVisible = false };
    }
}

/// <summary>ภาพประกอบของการ์ดแต่ละใบบนหน้า Home</summary>
internal static class IsoArt
{
    private static readonly Color Ink = Color.FromRgb(0xE6, 0xF3, 0xFF);
    private const string Play = "M0,0 L10,6 L0,12 Z";
    private const string Pin = "M6,0 C9.3,0 12,2.7 12,6 C12,10.5 6,16 6,16 C6,16 0,10.5 0,6 C0,2.7 2.7,0 6,0 Z M6,3.6 A2.4,2.4 0 1 0 6,8.4 A2.4,2.4 0 1 0 6,3.6 Z";
    private const string Alert = "M8,0 A8,8 0 1 1 7.99,0 Z M7,3.5 L9,3.5 L8.7,9.5 L7.3,9.5 Z M8,10.8 A1.1,1.1 0 1 1 7.99,10.8 Z";

    /// <summary>ผังกล้อง: จอแบ่ง 4 ช่องบนขาตั้ง กับกล้องโดมบนพื้น</summary>
    public static FrameworkElement Wall() => new IsoScene(Ink)
        .Plate(0, 1.5, 0, 10.5, 7.5)
        .Box(3.2, 2.6, 0, 2.4, 1.6, 0.3)
        .Box(4.0, 3.0, 0.3, 0.8, 0.6, 1.6)
        .Box(0.5, 3.3, 1.9, 7.6, 0.45, 4.6)
        .FaceY(3.75, 0.8, 7.8, 2.2, 6.2)
        .Line(4.3, 3.75, 2.2, 4.3, 3.75, 6.2, 0.6).Line(0.8, 3.75, 4.2, 7.8, 3.75, 4.2, 0.6)
        .Glyph(6.1, 3.75, 5.2, Play, 13)
        .Line(8.3, 7.4, 0.05, 4.5, 4.8, 0.05, 0.45)
        .Box(8.3, 6.6, 0, 1.6, 1.6, 0.5)
        .Box(8.7, 7.0, 0.5, 0.8, 0.8, 0.6, 0.7)
        .Build();

    /// <summary>ภาพย้อนหลัง: จอพร้อมเส้นเวลา ปุ่มเล่น และกล่องเก็บภาพซ้อนกัน</summary>
    public static FrameworkElement Playback() => new IsoScene(Ink)
        .Plate(-0.5, 0, 0, 11.5, 9)
        .Box(0, 0.5, 0, 2.2, 2.2, 0.9).Box(0, 0.5, 0.9, 2.2, 2.2, 0.9).Box(0, 0.5, 1.8, 2.2, 2.2, 0.9)
        .Box(3.6, 2.8, 0, 2.2, 1.4, 0.3)
        .Box(4.3, 3.1, 0.3, 0.8, 0.6, 1.4)
        .Box(1.6, 3.4, 1.7, 7.4, 0.45, 4.4)
        .FaceY(3.85, 1.9, 8.7, 2.0, 6.0)
        .Glyph(5.3, 3.85, 4.4, Play, 18)
        .Line(2.3, 3.85, 2.6, 8.3, 3.85, 2.6, 0.45, 2.2).Line(2.3, 3.85, 2.6, 5.6, 3.85, 2.6, 0.95, 2.2)
        .Line(3.2, 3.85, 2.35, 3.2, 3.85, 2.85, 0.9).Line(6.9, 3.85, 2.35, 6.9, 3.85, 2.85, 0.9)
        .Ring(9.2, 7.2, 0, 1.5, 0.8, true)
        .Line(9.2, 7.2, 0, 9.2, 6.1, 0, 0.95, 1.6).Line(9.2, 7.2, 0, 10.0, 7.2, 0, 0.95, 1.6)
        .Build();

    /// <summary>แผนที่: แผ่นแผนที่มีถนน อาคาร และหมุดกล้อง</summary>
    public static FrameworkElement Map() => new IsoScene(Ink)
        .Box(0, 0, 0, 10, 9, 0.35, 0.3)
        .Line(0, 4, 0.36, 10, 4, 0.36, 0.55, 1.6).Line(5.5, 0, 0.36, 5.5, 9, 0.36, 0.55, 1.6)
        .Box(1, 1, 0.35, 2, 2, 2.2).Box(6.5, 0.8, 0.35, 2.4, 1.8, 3.4).Box(1.2, 5.2, 0.35, 1.8, 2.6, 1.4)
        .Box(7.2, 5.4, 0.35, 1.6, 1.6, 1.0)
        .Ring(4.2, 5.8, 0.36, 1.1, 0.8, true)
        .Glyph(4.2, 5.8, 3.0, Pin, 30, 1, Color.FromRgb(0xFF, 0xE0, 0x6A))
        .Build();

    /// <summary>เหตุการณ์ AI: บัตรเหตุการณ์ตั้งอยู่บนแผ่น ภาพย่อ และป้ายแจ้งเตือนพร้อมคลื่น</summary>
    public static FrameworkElement Events() => new IsoScene(Ink)
        .Plate(0, 1, 0, 10.5, 8.5)
        .Ring(7.5, 6.5, 0, 2.2, 0.35).Ring(7.5, 6.5, 0, 1.4, 0.55)
        .Box(0.6, 1.6, 0.0, 6.2, 0.4, 4.6)
        .FaceY(2.0, 1.0, 3.6, 1.8, 4.2)
        .Line(4.0, 2.0, 3.9, 6.4, 2.0, 3.9, 0.85, 1.6).Line(4.0, 2.0, 3.1, 6.0, 2.0, 3.1, 0.6, 1.4).Line(4.0, 2.0, 2.3, 5.4, 2.0, 2.3, 0.6, 1.4)
        .Box(2.6, 4.2, 0, 4.4, 0.35, 2.6, 0.45)
        .FaceY(4.55, 2.9, 4.8, 0.4, 2.2)
        .Box(7.0, 6.0, 0, 1.0, 1.0, 1.6, 0.65)
        .Glyph(7.5, 6.5, 3.6, Alert, 26, 1, Color.FromRgb(0xFF, 0xF1, 0xE6))
        .Build();

    /// <summary>รายละเอียดกล้อง: กล้อง bullet บนขายึด กับแผงข้อมูลกล้อง</summary>
    public static FrameworkElement Devices() => new IsoScene(Ink)
        .Plate(1.5, 0, 0, 7.5, 7.5)
        .Box(7.6, 0.6, 0, 0.35, 5.2, 5.6, 0.45)
        .FaceX(7.95, 1.0, 5.4, 4.2, 5.2, 0.3)
        .Line(7.95, 1.2, 3.6, 7.95, 4.8, 3.6, 0.8, 1.4).Line(7.95, 1.2, 2.8, 7.95, 4.2, 2.8, 0.6, 1.4)
        .Line(7.95, 1.2, 2.0, 7.95, 4.6, 2.0, 0.6, 1.4).Line(7.95, 1.2, 1.2, 7.95, 3.6, 1.2, 0.6, 1.4)
        .Box(2.4, 2.6, 0, 2.2, 2.2, 0.4)
        .Box(3.25, 3.45, 0.4, 0.5, 0.5, 2.8)
        .Box(2.9, 1.2, 3.2, 1.3, 5.0, 1.3)
        .Box(2.7, 5.9, 3.0, 1.7, 0.6, 1.7, 0.5)
        .Ring(3.55, 6.5, 3.85, 0.45, 0.9, true)
        .Glyph(3.55, 6.5, 3.85, "M0,0 A6,6 0 1 1 0.01,0 Z", 9, 0.9)
        .Build();

    /// <summary>ตรวจระบบ: ตู้ server มีช่องไฟสถานะ กับกราฟแท่งบนแผ่นฐาน</summary>
    public static FrameworkElement Diagnostics() => new IsoScene(Ink)
        .Plate(0, 0.5, 0, 11, 7.8)
        .Box(0.5, 1.0, 0, 2.8, 2.6, 6.4)
        .FaceY(3.6, 0.8, 3.0, 5.0, 5.8, 0.3).FaceY(3.6, 0.8, 3.0, 3.8, 4.6, 0.3).FaceY(3.6, 0.8, 3.0, 2.6, 3.4, 0.3).FaceY(3.6, 0.8, 3.0, 1.4, 2.2, 0.3)
        .Line(2.5, 3.6, 5.4, 2.7, 3.6, 5.4, 1, 2.2).Line(2.5, 3.6, 4.2, 2.7, 3.6, 4.2, 1, 2.2).Line(2.5, 3.6, 3.0, 2.7, 3.6, 3.0, 1, 2.2)
        .Box(4.6, 5.2, 0, 5.8, 2.0, 0.3, 0.35)
        .Box(5.0, 5.6, 0.3, 0.9, 0.9, 1.6).Box(6.4, 5.6, 0.3, 0.9, 0.9, 2.8).Box(7.8, 5.6, 0.3, 0.9, 0.9, 2.1).Box(9.2, 5.6, 0.3, 0.9, 0.9, 3.6)
        .Line(3.3, 2.3, 0.05, 4.6, 6.2, 0.05, 0.5)
        .Build();
}
