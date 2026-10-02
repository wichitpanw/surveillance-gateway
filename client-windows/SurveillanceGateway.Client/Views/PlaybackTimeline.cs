using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// แถบเวลาหนึ่งวันของหน้าภาพย้อนหลัง: แสดงช่วงที่มีบันทึก หัวเล่น และเวลาใต้เมาส์
/// คลิก = ไปเวลานั้น · ล้อเมาส์ = ซูม (ตั้งแต่ 24 ชม. ถึง 10 นาที) · ลาก = เลื่อนช่วงที่ซูมอยู่
/// หน่วยทุกค่าเป็นวินาทีนับจากเที่ยงคืนของวันที่เลือก (0–86400)
/// </summary>
public sealed class PlaybackTimeline : FrameworkElement
{
    private const double Day = 86400;
    private const double MinSpan = 600;
    private const double LabelHeight = 18;
    private const double BarHeight = 26;
    private const double DragThreshold = 4;

    private IReadOnlyList<(double Start, double End)> _ranges = Array.Empty<(double, double)>();
    private double? _playhead;
    private double? _hover;
    private double _viewStart;
    private double _viewEnd = Day;
    private Point? _pressAt;
    private double _pressViewStart;
    private bool _dragging;

    /// <summary>ผู้ใช้เลือกเวลา (วินาทีของวัน) — หน้า Playback เริ่มเล่นจากเวลานั้น</summary>
    public event Action<double>? SeekRequested;

    public PlaybackTimeline()
    {
        Height = LabelHeight + BarHeight + 8;
        Cursor = Cursors.Hand;
        Focusable = false;
        ClipToBounds = true;
    }

    public IReadOnlyList<(double Start, double End)> Ranges
    {
        get => _ranges;
        set
        {
            _ranges = value ?? Array.Empty<(double, double)>();
            InvalidateVisual();
        }
    }

    public double? Playhead
    {
        get => _playhead;
        set
        {
            if (_playhead == value) return;
            _playhead = value;
            KeepInView(value);
            InvalidateVisual();
        }
    }

    public double ViewSpan => _viewEnd - _viewStart;

    /// <summary>กลับไปดูทั้งวัน</summary>
    public void ShowWholeDay() => SetView(0, Day);

    /// <summary>ซูมรอบจุดกึ่งกลาง (หรือหัวเล่นถ้ามี) — factor น้อยกว่า 1 = ขยาย</summary>
    public void Zoom(double factor) => ZoomAround(_playhead ?? (_viewStart + _viewEnd) / 2, factor);

    private void ZoomAround(double anchor, double factor)
    {
        var span = Math.Clamp(ViewSpan * factor, MinSpan, Day);
        var ratio = ViewSpan > 0 ? (anchor - _viewStart) / ViewSpan : 0.5;
        var start = anchor - span * ratio;
        SetView(start, start + span);
    }

    private void SetView(double start, double end)
    {
        var span = Math.Clamp(end - start, MinSpan, Day);
        start = Math.Clamp(start, 0, Day - span);
        _viewStart = start;
        _viewEnd = start + span;
        InvalidateVisual();
    }

    /// <summary>หัวเล่นวิ่งออกนอกช่วงที่ซูมอยู่ → เลื่อนช่วงตามไป (ไม่เปลี่ยนระดับซูม)</summary>
    private void KeepInView(double? seconds)
    {
        if (seconds is not { } s || _dragging || (s >= _viewStart && s <= _viewEnd)) return;
        var span = ViewSpan;
        SetView(s - span * 0.1, s - span * 0.1 + span);
    }

    private double ToX(double seconds) => (seconds - _viewStart) / ViewSpan * ActualWidth;

    private double ToSeconds(double x) => Math.Clamp(_viewStart + x / Math.Max(1, ActualWidth) * ViewSpan, 0, Day - 1);

    private Brush Res(string key, Brush fallback) => TryFindResource(key) as Brush ?? fallback;

    /// <summary>ระยะห่างของขีดเวลา: เลือกค่าที่ทำให้ป้ายห่างกันอย่างน้อย ~70 px</summary>
    private double TickStep()
    {
        double[] steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
        var perPixel = ViewSpan / Math.Max(1, ActualWidth);
        return steps.FirstOrDefault(s => s / perPixel >= 70, 21600);
    }

    private FormattedText Label(string text, Brush brush) => new(
        text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
        new Typeface(TryFindResource("MonoFont") as FontFamily ?? new FontFamily("Consolas"), FontStyles.Normal, FontWeights.Normal, FontStretches.Normal),
        10.5, brush, VisualTreeHelper.GetDpi(this).PixelsPerDip);

    private static string Clock(double seconds, bool withSeconds = false)
    {
        var t = TimeSpan.FromSeconds(Math.Clamp(Math.Round(seconds), 0, Day));
        if (t.TotalHours >= 24) return "24:00";
        return withSeconds ? t.ToString(@"hh\:mm\:ss") : t.ToString(@"hh\:mm");
    }

    protected override void OnRender(DrawingContext dc)
    {
        var width = ActualWidth;
        if (width <= 0) return;
        var faint = Res("FaintForegroundBrush", Brushes.Gray);
        var muted = Res("MutedBrush", Brushes.LightGray);
        var border = Res("BorderBrush", Brushes.Gray);
        var data = Res("DataBrush", Brushes.SteelBlue);
        var accent = Res("BrandYellowBrush", Brushes.Gold);
        var foreground = Res("ForegroundBrush", Brushes.Black);

        dc.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, width, ActualHeight));

        var barTop = LabelHeight;
        var bar = new Rect(0, barTop, width, BarHeight);
        dc.DrawRoundedRectangle(muted, new Pen(border, 1), bar, 6, 6);

        // ช่วงที่มีภาพ
        dc.PushClip(new RectangleGeometry(bar, 6, 6));
        foreach (var (start, end) in _ranges)
        {
            if (end <= _viewStart || start >= _viewEnd) continue;
            var x1 = Math.Max(0, ToX(start));
            var x2 = Math.Min(width, ToX(end));
            dc.DrawRectangle(data, null, new Rect(x1, barTop + 5, Math.Max(2, x2 - x1), BarHeight - 10));
        }

        // ขีดเวลา
        var step = TickStep();
        var linePen = new Pen(border, 1);
        for (var t = Math.Ceiling(_viewStart / step) * step; t <= _viewEnd; t += step)
        {
            var x = Math.Round(ToX(t)) + 0.5;
            dc.DrawLine(linePen, new Point(x, barTop + BarHeight - 5), new Point(x, barTop + BarHeight));
        }
        dc.Pop();

        for (var t = Math.Ceiling(_viewStart / step) * step; t <= _viewEnd; t += step)
        {
            var label = Label(Clock(t), faint);
            var x = Math.Clamp(ToX(t) - label.Width / 2, 0, width - label.Width);
            dc.DrawText(label, new Point(x, 1));
        }

        // เวลาใต้เมาส์
        if (_hover is { } hover && !_dragging)
        {
            var x = Math.Round(ToX(hover)) + 0.5;
            dc.DrawLine(new Pen(foreground, 1) { DashStyle = DashStyles.Dash }, new Point(x, barTop), new Point(x, barTop + BarHeight));
            var tip = Label(Clock(hover, true), foreground);
            var tipRect = new Rect(Math.Clamp(x - tip.Width / 2 - 5, 0, width - tip.Width - 10), 0, tip.Width + 10, LabelHeight - 2);
            dc.DrawRoundedRectangle(Res("PanelBrush", Brushes.White), new Pen(border, 1), tipRect, 4, 4);
            dc.DrawText(tip, new Point(tipRect.X + 5, 1));
        }

        // หัวเล่น
        if (_playhead is { } head && head >= _viewStart && head <= _viewEnd)
        {
            var x = ToX(head);
            dc.DrawRectangle(accent, null, new Rect(x - 1, barTop - 2, 2, BarHeight + 4));
            var cap = new StreamGeometry();
            using (var g = cap.Open())
            {
                g.BeginFigure(new Point(x - 5, barTop - 3), true, true);
                g.LineTo(new Point(x + 5, barTop - 3), true, false);
                g.LineTo(new Point(x, barTop + 3), true, false);
            }
            cap.Freeze();
            dc.DrawGeometry(accent, null, cap);
        }
    }

    protected override void OnMouseWheel(MouseWheelEventArgs e)
    {
        ZoomAround(ToSeconds(e.GetPosition(this).X), e.Delta > 0 ? 0.7 : 1 / 0.7);
        e.Handled = true;
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        _pressAt = e.GetPosition(this);
        _pressViewStart = _viewStart;
        _dragging = false;
        CaptureMouse();
        e.Handled = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        var p = e.GetPosition(this);
        if (_pressAt is { } press && e.LeftButton == MouseButtonState.Pressed)
        {
            if (!_dragging && Math.Abs(p.X - press.X) > DragThreshold && ViewSpan < Day) _dragging = true;
            if (_dragging)
            {
                var delta = (press.X - p.X) / Math.Max(1, ActualWidth) * ViewSpan;
                SetView(_pressViewStart + delta, _pressViewStart + delta + ViewSpan);
                Cursor = Cursors.SizeWE;
            }
        }
        _hover = ToSeconds(p.X);
        InvalidateVisual();
    }

    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        var p = e.GetPosition(this);
        var wasDrag = _dragging;
        // ปล่อยเมาส์โดยไม่ได้กดบนเส้นเวลา (เช่นคลิกปิด calendar popup แล้วปล่อยบนนี้) ต้องไม่ seek
        var pressed = _pressAt is not null;
        _pressAt = null;
        _dragging = false;
        Cursor = Cursors.Hand;
        ReleaseMouseCapture();
        if (pressed && !wasDrag) SeekRequested?.Invoke(ToSeconds(p.X));
        e.Handled = true;
    }

    protected override void OnMouseLeave(MouseEventArgs e)
    {
        _hover = null;
        InvalidateVisual();
    }

    protected override void OnRenderSizeChanged(SizeChangedInfo sizeInfo)
    {
        base.OnRenderSizeChanged(sizeInfo);
        InvalidateVisual();
    }
}
